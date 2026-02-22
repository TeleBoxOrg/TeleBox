import { Plugin } from "@utils/pluginBase";
import { loadPlugins } from "@utils/pluginManager";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
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

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// 临时目录和退出文件
const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");

// 配置数据库路径
const assetsDir = createDirectoryInAssets("reload");
const configPath = path.join(assetsDir, "config.json");

// 默认配置
interface ReloadConfig {
  leakfixEnabled: boolean;
  memoryThreshold: number; // MB
}

// 初始化配置数据库
async function initConfig() {
  const db = await JSONFilePreset<ReloadConfig>(configPath, {
    leakfixEnabled: false,
    memoryThreshold: 150
  });
  return db;
}

// 编辑退出消息
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

// 执行退出逻辑
async function executeExit(msg: Api.Message) {
  const result = await msg.edit({
    text: "🔄 结束进程...",
  });
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

// 获取内存使用情况
function getMemoryUsage(): {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  threshold: number;
  percentage: number;
} {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const heapTotalMB = usage.heapTotal / 1024 / 1024;
  const rssMB = usage.rss / 1024 / 1024;
  const externalMB = usage.external / 1024 / 1024;
  const arrayBuffersMB = (usage as any).arrayBuffers / 1024 / 1024;
  
  return {
    heapUsed: heapUsedMB,
    heapTotal: heapTotalMB,
    rss: rssMB,
    external: externalMB,
    arrayBuffers: arrayBuffersMB,
    threshold: 0,
    percentage: 0
  };
}

// 格式化内存信息为HTML
function formatMemoryInfo(memory: ReturnType<typeof getMemoryUsage>): string {
  return `📊 <b>TeleBox 内存使用情况</b>

<b>堆内存 (Heap):</b>
• 已使用: <code>${memory.heapUsed.toFixed(2)} MB</code>
• 总分配: <code>${memory.heapTotal.toFixed(2)} MB</code>
• 占用率: <code>${((memory.heapUsed / memory.heapTotal) * 100).toFixed(2)}%</code>

<b>常驻内存 (RSS):</b>
• <code>${memory.rss.toFixed(2)} MB</code>

<b>外部内存:</b>
• <code>${memory.external.toFixed(2)} MB</code>

<b>ArrayBuffers:</b>
• <code>${memory.arrayBuffers.toFixed(2)} MB</code>

<b>配置信息:</b>
• 阈值: <code>${memory.threshold} MB</code>
• 堆内存占比: <code>${memory.percentage.toFixed(2)}%</code>`;
}

// 定时任务：内存监控
async function memoryMonitorTask() {
  try {
    const configDB = await initConfig();
    const config = configDB.data;
    
    if (!config.leakfixEnabled) {
      return;
    }
    
    const memory = getMemoryUsage();
    const threshold = config.memoryThreshold;
    
    if (memory.heapUsed > threshold) {
      console.log(`[Memory Monitor] 内存使用 ${memory.heapUsed.toFixed(2)}MB 超过阈值 ${threshold}MB，触发重启`);
      
      const client = await getGlobalClient();
      if (client) {
        await client.sendMessage("me", {
          message: `⚠️ <b>内存监控告警</b>\n\n堆内存使用: <code>${memory.heapUsed.toFixed(2)} MB</code>\n阈值: <code>${threshold} MB</code>\n\n正在重启 TeleBox...`,
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

// leakfix 帮助文本
const LEAKFIX_HELP = `🔧 <b>内存泄露修复 (LeakFix)</b>

<b>功能说明:</b>
自动监控 TeleBox 内存占用，超过阈值时自动重启，防止内存泄露导致的性能下降。

<b>可用命令:</b>
• <code>${mainPrefix}leakfix on</code> - 启用内存泄露修复
• <code>${mainPrefix}leakfix off</code> - 禁用内存泄露修复
• <code>${mainPrefix}leakfix set [MB]</code> - 设置内存阈值
• <code>${mainPrefix}leakfix status</code> - 查看当前状态
• <code>${mainPrefix}leakfix help</code> - 显示帮助

<b>启用后效果:</b>
✅ .reload 命令将触发完整重启
✅ 每小时自动检查内存占用
✅ 超过阈值时自动重启 TeleBox

<b>默认阈值:</b> 150 MB`;

class ReloadPlugin extends Plugin {
  description:
    | string
    | (() => string)
    | (() => Promise<string>) = `🔄 <b>Reload - 插件重载与内存管理</b>

<b>核心命令:</b>
• <code>${mainPrefix}reload</code> - 重新加载所有插件
• <code>${mainPrefix}exit</code> - 优雅退出进程
• <code>${mainPrefix}health</code> - 查看内存使用情况
• <code>${mainPrefix}leakfix</code> - 内存泄露修复管理
• <code>${mainPrefix}pmr</code> - PM2 进程重启

<b>内存泄露修复:</b>
使用 <code>${mainPrefix}leakfix help</code> 查看详细说明`;

  // 定时任务：每小时检查一次内存
  cronTasks = {
    memoryMonitor: {
      cron: "0 * * * *", // 每小时整点执行
      description: "内存监控 - 检查内存占用并自动重启",
      handler: async () => {
        await memoryMonitorTask();
      }
    }
  };

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    // ========== 核心命令 ==========
    reload: async (msg) => {
      const configDB = await initConfig();
      const leakfixEnabled = configDB.data.leakfixEnabled;
      
      if (leakfixEnabled) {
        await msg.edit({ text: "🔄 内存泄露修复模式已启用，正在重启..." });
        await executeExit(msg);
        return;
      }
      
      await msg.edit({ text: "🔄 正在重新加载插件..." });
      try {
        const startTime = Date.now();
        await loadPlugins();
        const loadTime = Date.now() - startTime;
        const timeText = loadTime > 1000 ? `${(loadTime / 1000).toFixed(2)}s` : `${loadTime}ms`;
        
        await msg.edit({
          text: `✅ 插件已重新加载完成 (耗时: ${timeText})`,
        });
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
        memory.threshold = configDB.data.memoryThreshold;
        memory.percentage = (memory.heapUsed / memory.threshold) * 100;
        
        const infoText = formatMemoryInfo(memory);
        
        // 状态指示
        let statusEmoji = "🟢";
        let statusText = "正常";
        if (memory.percentage > 90) {
          statusEmoji = "🔴";
          statusText = "危险";
        } else if (memory.percentage > 70) {
          statusEmoji = "🟡";
          statusText = "警告";
        }
        
        const fullText = `${infoText}

<b>状态:</b> ${statusEmoji} <code>${statusText}</code> (${memory.percentage.toFixed(2)}%)
<b>泄露修复:</b> ${configDB.data.leakfixEnabled ? "✅ 已启用" : "❌ 未启用"}`;
        
        await msg.edit({ text: fullText, parseMode: "html" });
      } catch (error) {
        console.error("[Health] 命令执行失败:", error);
        await msg.edit({
          text: `❌ 获取内存信息失败: ${htmlEscape(error instanceof Error ? error.message : String(error))}`,
          parseMode: "html"
        });
      }
    },
    
    // ========== leakfix 独立命令 ==========
    leakfix: async (msg) => {
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCmd = parts[1]?.toLowerCase();
      
      const configDB = await initConfig();
      
      // 无参数、help 或 h 时显示帮助
      if (!subCmd || subCmd === "help" || subCmd === "h") {
        await msg.edit({ text: LEAKFIX_HELP, parseMode: "html" });
        return;
      }
      
      switch (subCmd) {
        case "on":
          configDB.data.leakfixEnabled = true;
          await configDB.write();
          await msg.edit({
            text: `✅ <b>内存泄露修复功能已启用</b>\n\n• reload 命令将触发重启\n• 每小时自动检查内存占用\n• 超过 ${configDB.data.memoryThreshold}MB 时自动重启`,
            parseMode: "html"
          });
          break;
          
        case "off":
          configDB.data.leakfixEnabled = false;
          await configDB.write();
          await msg.edit({
            text: "❌ <b>内存泄露修复功能已关闭</b>\n\nreload 命令将恢复为热重载模式",
            parseMode: "html"
          });
          break;
          
        case "set":
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
            text: `✅ <b>内存阈值已设置</b>\n\n新阈值: <code>${threshold} MB</code>\n当前状态: ${configDB.data.leakfixEnabled ? "✅ 已启用" : "❌ 未启用"}`,
            parseMode: "html"
          });
          break;
          
        case "status":
        case "s":
          const memory = getMemoryUsage();
          memory.threshold = configDB.data.memoryThreshold;
          memory.percentage = (memory.heapUsed / memory.threshold) * 100;
          
          let statusEmoji = "🟢";
          let statusText = "正常";
          if (memory.percentage > 90) {
            statusEmoji = "🔴";
            statusText = "危险";
          } else if (memory.percentage > 70) {
            statusEmoji = "🟡";
            statusText = "警告";
          }
          
          await msg.edit({
            text: `📊 <b>LeakFix 状态</b>\n\n` +
                  `• 功能: ${configDB.data.leakfixEnabled ? "✅ 已启用" : "❌ 未启用"}\n` +
                  `• 阈值: <code>${configDB.data.memoryThreshold} MB</code>\n` +
                  `• 当前: <code>${memory.heapUsed.toFixed(2)} MB</code>\n` +
                  `• 占比: ${statusEmoji} <code>${statusText}</code> (${memory.percentage.toFixed(2)}%)`,
            parseMode: "html"
          });
          break;
          
        default:
          await msg.edit({
            text: `❌ <b>未知子命令:</b> <code>${htmlEscape(subCmd)}</code>\n\n💡 使用 <code>${mainPrefix}leakfix help</code> 查看可用命令`,
            parseMode: "html"
          });
      }
    }
  };
}

const reloadPlugin = new ReloadPlugin();
export default reloadPlugin;