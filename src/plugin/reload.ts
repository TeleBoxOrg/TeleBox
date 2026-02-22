import { Plugin } from "@utils/pluginBase";
import { loadPlugins, getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";
import { createDirectoryInTemp, createDirectoryInAssets } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/globalClient";
import { exec } from "child_process";
import { promisify } from "util";
import { JSONFilePreset } from "lowdb/node";
import { cronManager } from "@utils/cronManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execAsync = promisify(exec);

// 修复1: 修复 HTML 转义函数 - 移除键值对中的空格
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;'
  }[m] || m));

const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");
const assetsDir = createDirectoryInAssets("reload");
const configPath = path.join(assetsDir, "config.json");

interface ReloadConfig {
  leakfixEnabled: boolean;
  memoryThreshold: number;
}

async function initConfig() {
  const db = await JSONFilePreset(configPath, {
    leakfixEnabled: false,
    memoryThreshold: 150
  });
  return db;
}

const editExitMsg = async () => {
  try {
    const data = fs.readFileSync(exitFile, "utf-8");
    const { messageId, chatId, time } = JSON.parse(data);
    const client = await getGlobalClient();
    if (client) {
      let target;
      try {
        target = await client.getEntity(chatId);
      } catch (e) {
        await client.getDialogs({ limit: 20 });
        try {
          target = await client.getEntity(chatId);
        } catch (innerE) {
          console.error("Failed to get entity for exit message:", innerE);
        }
      }
      await client.editMessage(chatId, {
        message: messageId,
        text: `✅ 重启完成, 耗时 ${Date.now() - time}ms`,
      });
      fs.unlinkSync(exitFile);
    }
  } catch (e) {
    console.error("Failed to edit exit message:", e);
  }
};

if (fs.existsSync(exitFile)) {
  editExitMsg();
}

async function executeExit(msg: Api.Message) {
  const result = await msg.edit({ text: "🔄 正在结束进程..." });
  if (result) {
    fs.writeFileSync(
      exitFile,
      JSON.stringify({
        messageId: result.id,
        chatId: result.chatId || result.peerId,
        time: Date.now(),
      }),
      "utf-8"
    );
  }
  process.exit(0);
}

function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed / 1024 / 1024,
    heapTotal: usage.heapTotal / 1024 / 1024,
    rss: usage.rss / 1024 / 1024,
    external: usage.external / 1024 / 1024,
    arrayBuffers: (usage as any).arrayBuffers / 1024 / 1024
  };
}

function formatMemoryInfo(memory: ReturnType<typeof getMemoryUsage>): string {
  return `📊 TeleBox 内存使用情况
堆内存 (Heap):
• 已使用: ${memory.heapUsed.toFixed(2)} MB
• 总分配: ${memory.heapTotal.toFixed(2)} MB
• 占用率: ${((memory.heapUsed / memory.heapTotal) * 100).toFixed(2)}%
常驻内存 (RSS):
• ${memory.rss.toFixed(2)} MB
外部内存:
• ${memory.external.toFixed(2)} MB
ArrayBuffers:
• ${memory.arrayBuffers.toFixed(2)} MB`;
}

async function memoryMonitorTask() {
  try {
    const configDB = await initConfig();
    const config = configDB.data;
    if (!config.leakfixEnabled) return;
    const memory = getMemoryUsage();
    const threshold = config.memoryThreshold;

    if (memory.heapUsed > threshold) {
      console.log(`[Memory Monitor] 内存使用 ${memory.heapUsed.toFixed(2)}MB 超过阈值 ${threshold}MB，触发重启`);
      const client = await getGlobalClient();
      if (client) {
        await client.sendMessage("me", {
          message: `⚠️ <b>内存监控告警</b>\n\n` +
                   `堆内存使用: <code>${memory.heapUsed.toFixed(2)} MB</code>\n` +
                   `阈值: <code>${threshold} MB</code>\n\n` +
                   `正在重启 TeleBox...`,
          parseMode: "html"
        });
        setTimeout(() => process.exit(0), 1000);
      }
    } else {
      console.log(`[Memory Monitor] 内存使用 ${memory.heapUsed.toFixed(2)}MB / ${threshold}MB，正常`);
    }
  } catch (error) {
    console.error("[Memory Monitor] 定时任务执行失败:", error);
  }
}

const HELP_TEXT = `🔄 Reload - 插件重载与内存管理

🔧 核心命令:
• <code> ${mainPrefix}reload </code> - 重新加载所有插件
• <code> ${mainPrefix}exit </code> - 退出进程
• <code> ${mainPrefix}pmr </code> - PM2 进程重启
• <code> ${mainPrefix}health </code> - 查看内存使用情况

🛡️ 内存泄露修复:可用命令:
• <code> ${mainPrefix}leakfix on </code> - 启用 LeakFix
• <code> ${mainPrefix}leakfix off </code> - 禁用 LeakFix
• <code> ${mainPrefix}leakfix set [MB] </code> - 设置内存阈值（默认150 MB）
• <code> ${mainPrefix}leakfix status </code> - 查看状态
启用后效果:
✅ 每小时自动检查内存占用，超过阈值时自动重启 TeleBox
✅ 重新加载后自动检测内存增长情况`;

class ReloadPlugin extends Plugin {
  description = HELP_TEXT;

  cronTasks = {
    memoryMonitor: {
      cron: "0 * * * *",
      description: "内存监控 - 检查内存占用并自动重启",
      handler: async () => await memoryMonitorTask()
    }
  };

  private lastReloadMemory: number | null = null;

  // 修复2: 修复 Promise 类型缺失
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    reload: async (msg) => {
      const beforeMemory = getMemoryUsage();
      this.lastReloadMemory = beforeMemory.heapUsed;
      await msg.edit({ text: "🔄 正在重新加载插件..." });
      try {
        const startTime = Date.now();
        await loadPlugins();
        const loadTime = Date.now() - startTime;
        const timeText = loadTime > 1000 ? `${(loadTime / 1000).toFixed(2)}s` : `${loadTime}ms`;

        const afterMemory = getMemoryUsage();
        const memoryGrowth = afterMemory.heapUsed - beforeMemory.heapUsed;

        const configDB = await initConfig();
        const threshold = configDB.data.memoryThreshold;
        const memoryChange = `${beforeMemory.heapUsed.toFixed(2)} MB -> ${afterMemory.heapUsed.toFixed(2)} MB (${memoryGrowth > 0 ? '+' : ''}${memoryGrowth.toFixed(2)} MB)`;

        let output = `✅ 插件已重新加载完成 (耗时: ${timeText})\n\n📊 内存变化: ${memoryChange}`;

        if (afterMemory.heapUsed > threshold) {
          output += `\n\n⚠️ <b>内存占用警告</b>：建议使用 <code>${mainPrefix}exit</code> 或 <code>${mainPrefix}pmr</code> 重启 TeleBox。`;
        }

        await msg.edit({ text: output, parseMode: "html" });
      } catch (error) {
        console.error("Plugin reload failed: ", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        await msg.edit({
          text: `❌ 插件重新加载失败\n错误信息: ${errorMessage}\n请检查控制台日志获取详细信息`,
        });
      }
    },

    exit: async (msg) => {
      await executeExit(msg);
    },

    pmr: async (msg) => {
      await msg.delete();
      setTimeout(async () => {
        try {
          await execAsync("pm2 restart telebox");
        } catch (error) {
          console.error("PM2 restart failed: ", error);
        }
      }, 500);
    },

    health: async (msg) => {
      try {
        const configDB = await initConfig();
        const memory = getMemoryUsage();
        const infoText = formatMemoryInfo(memory);

        let statusEmoji = "🟢";
        let statusText = "正常";
        if (memory.heapUsed > configDB.data.memoryThreshold) {
          statusEmoji = "🔴";
          statusText = "危险";
        } else if (memory.heapUsed > configDB.data.memoryThreshold * 0.7) {
          statusEmoji = "🟡";
          statusText = "警告";
        }

        const fullText = `${infoText}\n\n<b>状态:</b> ${statusEmoji} ${statusText}`;
        await msg.edit({ text: fullText, parseMode: "html" });
      } catch (error) {
        console.error("[Health] 命令执行失败: ", error);
        await msg.edit({
          text: `❌ 获取内存信息失败: ${htmlEscape(error instanceof Error ? error.message : String(error))}`,
          parseMode: "html"
        });
      }
    },

    leakfix: async (msg) => {
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCmd = parts[1]?.toLowerCase() || "help";
      const configDB = await initConfig();

      if (subCmd === "on") {
        configDB.data.leakfixEnabled = true;
        await configDB.write();
        await msg.edit({
          text: `✅ <b>内存泄露修复功能已启用</b>\n\n` +
                `• reload 后会检测内存增长\n` +
                `• 每小时自动检查内存占用\n` +
                `• 超过 ${configDB.data.memoryThreshold}MB 时自动重启`,
          parseMode: "html"
        });
      } else if (subCmd === "off") {
        configDB.data.leakfixEnabled = false;
        await configDB.write();
        await msg.edit({
          text: "❌ <b>内存泄露修复功能已关闭</b>\n\nreload 命令将不再检测内存增长",
          parseMode: "html"
        });
      } else if (subCmd === "set") {
        const threshold = parseInt(parts[2]);
        if (isNaN(threshold) || threshold <= 0) {
          await msg.edit({
            text: "❌ <b>参数错误</b>\n\n请提供有效的内存阈值（正整数，单位：MB）\n\n示例: <code>.leakfix set 150</code>",
            parseMode: "html"
          });
          return;
        }
        configDB.data.memoryThreshold = threshold;
        await configDB.write();
        await msg.edit({
          text: `✅ <b>内存阈值已设置</b>\n\n` +
                `新阈值: <code>${threshold} MB</code>\n` +
                `当前状态: ${configDB.data.leakfixEnabled ? "✅ 已启用" : "❌ 未启用"}`,
          parseMode: "html"
        });
      } else if (subCmd === "status" || subCmd === "s") {
        const memory = getMemoryUsage();
        const percentage = (memory.heapUsed / configDB.data.memoryThreshold) * 100;
        let statusEmoji = "🟢";
        let statusText = "正常";
        if (percentage > 90) {
          statusEmoji = "🔴";
          statusText = "危险";
        } else if (percentage > 70) {
          statusEmoji = "🟡";
          statusText = "警告";
        }
        await msg.edit({
          text: `📊 <b>LeakFix 状态</b>\n\n` +
                `• 功能: ${configDB.data.leakfixEnabled ? "✅ 已启用" : "❌ 未启用"}\n` +
                `• 阈值: <code>${configDB.data.memoryThreshold} MB</code>\n` +
                `• 当前: <code>${memory.heapUsed.toFixed(2)} MB</code>\n` +
                `• 占比: ${statusEmoji} <code>${statusText}</code> (${percentage.toFixed(2)}%)`,
          parseMode: "html"
        });
      } else {
        await msg.edit({ text: HELP_TEXT, parseMode: "html" });
      }
    }
  };
}

export default new ReloadPlugin();