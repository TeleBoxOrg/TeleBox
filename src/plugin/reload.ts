import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { createDirectoryInTemp, createDirectoryInAssets } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/globalClient";
import { exec } from "child_process";
import { promisify } from "util";
import { JSONFilePreset } from "lowdb/node";
import { getCurrentGeneration } from "@utils/globalClient";
import { reloadRuntime } from "@utils/runtimeManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execAsync = promisify(exec);

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
const pendingExitTimers = new Set<ReturnType<typeof setTimeout>>();

async function updateReloadStatus(params: {
  client: Api.Message["client"];
  targetChat: any;
  targetMessageId: number;
  text: string;
  parseMode?: "html";
}) {
  const { client, targetChat, targetMessageId, text, parseMode } = params;
  try {
    await client?.editMessage(targetChat, {
      message: targetMessageId,
      text,
      parseMode,
    });
  } catch (error) {
    console.error("Failed to edit reload status message, falling back to sendMessage:", error);
    await client?.sendMessage(targetChat, {
      message: text,
      parseMode,
    });
  }
}

interface ReloadConfig {
  leakfixEnabled: boolean;
  memoryThreshold: number;
  rssThreshold: number;
  runtimeGrowthThreshold: number;
  baselineHeapUsed: number | null;
  baselineRss: number | null;
  baselineMode: "on-enable" | "manual" | "on-reload";
  silentEnabled: boolean;
}

async function initConfig() {
  const db = await JSONFilePreset<ReloadConfig>(configPath, {
    leakfixEnabled: false,
    memoryThreshold: 150,
    rssThreshold: 512,
    runtimeGrowthThreshold: 120,
    baselineHeapUsed: null,
    baselineRss: null,
    baselineMode: "on-enable",
    silentEnabled: false
  });
  return db;
}

function formatMb(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "未记录";
  return `${value.toFixed(2)} MB`;
}

function updateMemoryBaseline(config: ReloadConfig, memory: ReturnType<typeof getMemoryUsage>): void {
  config.baselineHeapUsed = memory.heapUsed;
  config.baselineRss = memory.rss;
}

function formatBaselineMode(mode: ReloadConfig["baselineMode"]): string {
  if (mode === "manual") return "手动";
  if (mode === "on-reload") return "每次重载后自动更新";
  return "开启时自动记录";
}

function parseBaselineMode(input?: string): ReloadConfig["baselineMode"] | null {
  if (!input) return null;
  if (input === "auto" || input === "on-enable") return "on-enable";
  if (input === "reload" || input === "on-reload") return "on-reload";
  if (input === "manual") return "manual";
  return null;
}

function applyMemoryPreset(config: ReloadConfig, preset: "safe" | "normal" | "aggressive"): void {
  if (preset === "safe") {
    config.memoryThreshold = 120;
    config.rssThreshold = 420;
    config.runtimeGrowthThreshold = 80;
    return;
  }

  if (preset === "aggressive") {
    config.memoryThreshold = 220;
    config.rssThreshold = 768;
    config.runtimeGrowthThreshold = 180;
    return;
  }

  config.memoryThreshold = 150;
  config.rssThreshold = 512;
  config.runtimeGrowthThreshold = 120;
}

function getGrowthStatus(config: ReloadConfig, memory: ReturnType<typeof getMemoryUsage>) {
  const heapGrowth =
    config.baselineHeapUsed == null ? null : memory.heapUsed - config.baselineHeapUsed;
  const rssGrowth =
    config.baselineRss == null ? null : memory.rss - config.baselineRss;
  const growthThreshold = config.runtimeGrowthThreshold;
  const heapGrowthExceeded = heapGrowth != null && heapGrowth > growthThreshold;
  const rssGrowthExceeded = rssGrowth != null && rssGrowth > growthThreshold;

  return {
    heapGrowth,
    rssGrowth,
    growthThreshold,
    heapGrowthExceeded,
    rssGrowthExceeded,
  };
}

function buildMemoryAlertText(params: {
  memory: ReturnType<typeof getMemoryUsage>;
  config: ReloadConfig;
  reasons: string[];
  growth: ReturnType<typeof getGrowthStatus>;
}) {
  const { memory, config, reasons, growth } = params;
  return (
    `⚠️ <b>内存监控告警</b>\n\n` +
    `触发原因：\n• ${reasons.join("\n• ")}\n\n` +
    `当前内存：\n` +
    `• Heap：<code>${memory.heapUsed.toFixed(2)} MB</code> / 阈值 <code>${config.memoryThreshold} MB</code>\n` +
    `• RSS：<code>${memory.rss.toFixed(2)} MB</code> / 阈值 <code>${config.rssThreshold} MB</code>\n\n` +
    `运行期增长（相对基线）：\n` +
    `• Heap 增长：<code>${formatMb(growth.heapGrowth)}</code>\n` +
    `• RSS 增长：<code>${formatMb(growth.rssGrowth)}</code>\n` +
    `• 增长阈值：<code>${config.runtimeGrowthThreshold} MB</code>\n\n` +
    `正在重启 TeleBox...`
  );
}

function scheduleTrackedTimeout(
  callback: () => void | Promise<void>,
  delay: number
): ReturnType<typeof setTimeout> {
  let timer: ReturnType<typeof setTimeout>;
  timer = setTimeout(() => {
    pendingExitTimers.delete(timer);
    void Promise.resolve(callback());
  }, delay);
  pendingExitTimers.add(timer);
  return timer;
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
        text: `✅ 重启完成，耗时 ${Date.now() - time}ms`,
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
  • 已使用：${memory.heapUsed.toFixed(2)} MB
  • 总分配：${memory.heapTotal.toFixed(2)} MB
  • 占用率：${((memory.heapUsed / memory.heapTotal) * 100).toFixed(2)}%
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
    if (config.baselineHeapUsed == null || config.baselineRss == null) {
      updateMemoryBaseline(config, memory);
      await configDB.write();
    }

    const growth = getGrowthStatus(config, memory);
    const reasons: string[] = [];

    if (memory.heapUsed > config.memoryThreshold) {
      reasons.push(`Heap 使用 ${memory.heapUsed.toFixed(2)} MB 超过阈值 ${config.memoryThreshold} MB`);
    }
    if (memory.rss > config.rssThreshold) {
      reasons.push(`RSS 总内存 ${memory.rss.toFixed(2)} MB 超过阈值 ${config.rssThreshold} MB`);
    }
    if (growth.heapGrowthExceeded) {
      reasons.push(`Heap 相对基线增长 ${formatMb(growth.heapGrowth)} 超过阈值 ${config.runtimeGrowthThreshold} MB`);
    }
    if (growth.rssGrowthExceeded) {
      reasons.push(`RSS 相对基线增长 ${formatMb(growth.rssGrowth)} 超过阈值 ${config.runtimeGrowthThreshold} MB`);
    }

    if (reasons.length > 0) {
      console.log(`[Memory Monitor] 触发保护动作: ${reasons.join("; ")}`);
      const client = await getGlobalClient();
      if (client && !config.silentEnabled) {
        await client.sendMessage("me", {
          message: buildMemoryAlertText({ memory, config, reasons, growth }),
          parseMode: "html"
        });
      }

      let reloaded = false;
      try {
        const runtime = await reloadRuntime();
        const afterReloadMemory = getMemoryUsage();
        const afterReloadGrowth = getGrowthStatus(config, afterReloadMemory);
        reloaded = true;

        const stillExceeded =
          afterReloadMemory.heapUsed > config.memoryThreshold ||
          afterReloadMemory.rss > config.rssThreshold ||
          afterReloadGrowth.heapGrowthExceeded ||
          afterReloadGrowth.rssGrowthExceeded;

        if (config.baselineMode === "on-reload") {
          updateMemoryBaseline(config, afterReloadMemory);
          await configDB.write();
        }

        if (stillExceeded) {
          console.log("[Memory Monitor] Runtime 重建后内存仍超限，准备退出进程");
          if (!config.silentEnabled) {
            await runtime.client.sendMessage("me", {
              message:
                `⚠️ <b>Memory优化</b>\n\n` +
                `已先尝试自动整理内存，但占用仍然偏高。\n` +
                `• 当前内存：<code>${afterReloadMemory.heapUsed.toFixed(2)} MB</code>\n` +
                `• 当前总内存：<code>${afterReloadMemory.rss.toFixed(2)} MB</code>\n\n` +
                `即将重启整个程序。`,
              parseMode: "html"
            });
          }
          scheduleTrackedTimeout(() => process.exit(0), 1000);
        } else if (!config.silentEnabled) {
          await runtime.client.sendMessage("me", {
            message:
                `✅ <b>Memory优化</b>\n\n` +
              `已自动重建 Runtime，内存已恢复到安全范围。\n` +
              `• 当前内存：<code>${afterReloadMemory.heapUsed.toFixed(2)} MB</code>\n` +
              `• 当前总内存：<code>${afterReloadMemory.rss.toFixed(2)} MB</code>`,
            parseMode: "html"
          });
        }
      } catch (reloadError) {
        console.error("[Memory Monitor] 自动重建 Runtime 失败:", reloadError);
      }

      if (!reloaded) {
        if (client && !config.silentEnabled) {
          await client.sendMessage("me", {
            message:
              `⚠️ <b>Memory优化</b>\n\n` +
              `自动重建 Runtime 失败，准备直接重启整个程序。`,
            parseMode: "html"
          });
        }
        scheduleTrackedTimeout(() => process.exit(0), 1000);
      }
    } else {
      console.log(
        `[Memory Monitor] 正常: Heap ${memory.heapUsed.toFixed(2)}MB / ${config.memoryThreshold}MB, RSS ${memory.rss.toFixed(2)}MB / ${config.rssThreshold}MB, Heap增长 ${formatMb(growth.heapGrowth)}, RSS增长 ${formatMb(growth.rssGrowth)}`
      );
    }
  } catch (error) {
    console.error("[Memory Monitor] 定时任务执行失败:", error);
  }
}

const HELP_TEXT = `🔄 Reload - 插件重载与内存管理

🔧 核心命令:
• <code>${mainPrefix}reload</code> - 重新加载所有插件
• <code>${mainPrefix}exit</code> - 退出进程
• <code>${mainPrefix}pmr</code> - PM2 进程重启
• <code>${mainPrefix}health</code> - 查看内存使用情况

️🧩 Memory优化:
可用命令:
 • <code>${mainPrefix}memory on/off</code> - 启用/禁用内存守卫
 • <code>${mainPrefix}memory status</code> - 查看当前状态
 • <code>${mainPrefix}memory reset</code> - 重新记录当前内存基线
 • <code>${mainPrefix}memory mode [auto/manual/reload]</code> - 设置基线记录方式
 • <code>${mainPrefix}memory set [safe/normal/aggressive]</code> - 一键套用推荐预设
 • <code>${mainPrefix}memory set heap [MB]</code> - 自定义内存阈值
 • <code>${mainPrefix}memory set rss [MB]</code> - 自定义总内存阈值
 • <code>${mainPrefix}memory set growth [MB]</code> - 自定义增长阈值
 • <code>${mainPrefix}memory silent on/off</code> - 启用/禁用静默模式（自动重启时不发送通知）

模式说明:
• <code>auto</code> - 开启 memory 时，自动把当前内存记为基线
• <code>manual</code> - 只有执行 <code>${mainPrefix}memory reset</code> 时才更新基线
• <code>reload</code> - 每次执行 <code>${mainPrefix}reload</code> 后，自动更新基线

预设说明:
• <code>safe</code> - 更保守，更早介入，适合担心内存上涨过快的场景
• <code>normal</code> - 默认平衡模式，适合大多数情况
• <code>aggressive</code> - 更宽松，减少打扰，适合内存本来就偏高的大插件环境

工作方式:
✅ 定时检查“内存 / 总内存 / 相对基线增长”
✅ 超过阈值时，先尝试自动重建 Runtime
✅ 如果自动整理后仍然过高，再重启整个程序
✅ 开启后可以用 <code>${mainPrefix}memory status</code> 查看当前状态与建议动作`;

class ReloadPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingExitTimers) {
      clearTimeout(timer);
    }
    pendingExitTimers.clear();
    this.lastReloadMemory = null;
  }

  description = HELP_TEXT;
  cronTasks = {
    memoryMonitor: {
      cron: "0 * * * *",
      description: "内存监控 - 检查内存占用并自动重启",
      handler: async () => await memoryMonitorTask()
    }
  };
  private lastReloadMemory: number | null = null;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    reload: async (msg) => {
      const beforeMemory = getMemoryUsage();
      this.lastReloadMemory = beforeMemory.heapUsed;
      const statusMessage = await msg.edit({ text: "🔄 正在重新加载插件..." });
      const targetChat = statusMessage?.chatId || statusMessage?.peerId || msg.chatId || msg.peerId;
      const targetMessageId = statusMessage?.id || msg.id;
      try {
        const startTime = Date.now();
        const runtime = await reloadRuntime();
        const loadTime = Date.now() - startTime;
        const timeText = loadTime > 1000 ? `${(loadTime / 1000).toFixed(2)}s` : `${loadTime}ms`;
        const configDB = await initConfig();
        const afterMemory = getMemoryUsage();

        if (configDB.data.baselineMode === "on-reload") {
          updateMemoryBaseline(configDB.data, afterMemory);
          await configDB.write();
        }

        const output = `✅ Telebox 已重新加载 (用时：${timeText})`;

        await updateReloadStatus({
          client: runtime.client,
          targetChat,
          targetMessageId,
          text: output,
          parseMode: "html",
        });
      } catch (error) {
        console.error("Plugin reload failed:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          const client = await getGlobalClient();
          await updateReloadStatus({
            client,
            targetChat,
            targetMessageId,
            text: `❌ 插件重新加载失败\n错误信息：${errorMessage}\n请检查控制台日志获取详细信息`,
          });
        } catch (editError) {
          console.error("Failed to update reload status message:", editError);
        }
      }
    },

    exit: async (msg) => {
      await executeExit(msg);
    },

    pmr: async (msg) => {
      await msg.delete();
      scheduleTrackedTimeout(async () => {
        try {
          await execAsync("pm2 restart telebox");
        } catch (error) {
          console.error("PM2 restart failed:", error);
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

        const fullText = `${infoText}\n\n<b>状态：</b> ${statusEmoji} ${statusText}`;
        await msg.edit({ text: fullText, parseMode: "html" });
      } catch (error) {
        console.error("[Health] 命令执行失败:", error);
        await msg.edit({
          text: `❌ 获取内存信息失败：${htmlEscape(error instanceof Error ? error.message : String(error))}`,
          parseMode: "html"
        });
      }
    },

    memory: async (msg) => {
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCmd = parts[1]?.toLowerCase() || "help";
      const configDB = await initConfig();

      if (subCmd === "on") {
        configDB.data.leakfixEnabled = true;
        if (configDB.data.baselineMode === "on-enable") {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
        }
        await configDB.write();
        await msg.edit({
          text: `✅ <b>Memory优化已启用</b>\n\n` +
                `🛠️ 内存偏高时，会先自动尝试恢复\n` +
                `🔁 如果恢复后还是偏高，会自动重启程序\n` +
                `📝 当前记录方式：${formatBaselineMode(configDB.data.baselineMode)}`,
          parseMode: "html"
        });
      } else if (subCmd === "off") {
        configDB.data.leakfixEnabled = false;
        await configDB.write();
        await msg.edit({
          text: "❌ <b>Memory优化已关闭</b>\n\n系统将不再自动处理内存偏高的情况。",
          parseMode: "html"
        });
      } else if (subCmd === "set") {
        const target = parts[2]?.toLowerCase();
        const threshold = parseInt(parts[3]);

        if (target && ["safe", "normal", "aggressive"].includes(target)) {
          applyMemoryPreset(configDB.data, target as "safe" | "normal" | "aggressive");
          await configDB.write();
          const presetText =
            target === "safe"
              ? "更保守，更早介入"
              : target === "aggressive"
                ? "更宽松，减少打扰"
                : "平衡模式，适合大多数情况";
          await msg.edit({
            text: `✅ <b>已切换内存预设</b>\n\n` +
                  `🎛️ 当前预设：<code>${target}</code>\n` +
                  `💡 说明：${presetText}`,
            parseMode: "html"
          });
          return;
        }

        if (isNaN(threshold) || threshold <= 0) {
          await msg.edit({
            text: `❌ <b>参数错误</b>\n\n请提供有效的内存阈值（正整数，单位：MB）\n\n` +
                  `快速预设：<code>${mainPrefix}memory set safe</code> / <code>normal</code> / <code>aggressive</code>\n` +
                  `示例：<code>${mainPrefix}memory set heap 150</code>\n` +
                  `<code>${mainPrefix}memory set rss 512</code>\n` +
                  `<code>${mainPrefix}memory set growth 120</code>`,
            parseMode: "html"
          });
          return;
        }

        if (target === "heap") {
          configDB.data.memoryThreshold = threshold;
        } else if (target === "rss") {
          configDB.data.rssThreshold = threshold;
        } else if (target === "growth") {
          configDB.data.runtimeGrowthThreshold = threshold;
        } else {
          await msg.edit({
            text: `❌ <b>未知阈值类型</b>\n\n` +
                  `支持：<code>heap</code> / <code>rss</code> / <code>growth</code>`,
            parseMode: "html"
          });
          return;
        }

        await configDB.write();
        await msg.edit({
          text: `✅ <b>设置已更新</b>\n\n` +
                `⚙️ 项目：<code>${target}</code>\n` +
                `📏 新值：<code>${threshold} MB</code>`,
          parseMode: "html"
        });
      } else if (subCmd === "reset") {
        updateMemoryBaseline(configDB.data, getMemoryUsage());
        await configDB.write();
        await msg.edit({
          text: `✅ <b>已重新记录当前内存状态</b>\n\n📝 之后的“增长”会从现在开始重新计算。`,
          parseMode: "html"
        });
      } else if (subCmd === "mode") {
        const mode = parseBaselineMode(parts[2]?.toLowerCase());
        if (!mode) {
          await msg.edit({
            text: `❌ <b>未知模式</b>\n\n可用：<code>auto</code> / <code>manual</code> / <code>reload</code>`,
            parseMode: "html"
          });
          return;
        }

        configDB.data.baselineMode = mode;
        if (mode === "on-enable" && configDB.data.leakfixEnabled) {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
        }
        await configDB.write();
        await msg.edit({
          text: `✅ <b>记录方式已更新</b>\n\n` +
                `📝 当前方式：${formatBaselineMode(mode)}`,
          parseMode: "html"
        });
      } else if (subCmd === "baseline") {
        const action = parts[2]?.toLowerCase() || "status";
        if (action === "reset") {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
          await configDB.write();
          await msg.edit({
            text: `✅ <b>已重新记录当前内存状态</b>\n\n` +
                  `📝 当前记录方式：${formatBaselineMode(configDB.data.baselineMode)}`,
            parseMode: "html"
          });
        } else if (action === "mode") {
          const mode = parseBaselineMode(parts[3]?.toLowerCase());
          if (!mode) {
            await msg.edit({
              text: `❌ <b>未知基线策略</b>\n\n` +
                    `支持：<code>auto</code> / <code>manual</code> / <code>reload</code>\n\n` +
                    `示例：<code>${mainPrefix}memory mode reload</code>`,
              parseMode: "html"
            });
            return;
          }

          configDB.data.baselineMode = mode;
          if (mode === "on-enable" && configDB.data.leakfixEnabled) {
            updateMemoryBaseline(configDB.data, getMemoryUsage());
          }
          await configDB.write();
          await msg.edit({
            text: `✅ <b>记录方式已更新</b>\n\n` +
                  `📝 当前方式：${formatBaselineMode(mode)}`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `📏 <b>运行时内存基线</b>\n\n` +
                  `🧠 内存基线：<code>${formatMb(configDB.data.baselineHeapUsed)}</code>\n` +
                  `🖥️ 总内存基线：<code>${formatMb(configDB.data.baselineRss)}</code>\n` +
                  `📝 当前方式：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
                  `🔄 重置命令：<code>${mainPrefix}memory reset</code>\n` +
                  `⚙️ 设置命令：<code>${mainPrefix}memory mode auto|manual|reload</code>`,
            parseMode: "html"
          });
        }
      } else if (subCmd === "silent") {
        const silentCmd = parts[2]?.toLowerCase() || "help";
        if (silentCmd === "on") {
          configDB.data.silentEnabled = true;
          await configDB.write();
          await msg.edit({
            text: `✅ <b>静默模式已启用</b>\n\n` +
                  `• 内存超限自动重启时将<b>不发送</b>通知\n` +
                  `• 仍会在控制台记录日志`,
            parseMode: "html"
          });
        } else if (silentCmd === "off") {
          configDB.data.silentEnabled = false;
          await configDB.write();
          await msg.edit({
            text: `✅ <b>静默模式已关闭</b>\n\n` +
                  `• 内存超限自动重启时将<b>发送</b>通知到 "me"`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `📊 <b>Memory优化静默模式</b>\n\n` +
                  `🔕 <code>${mainPrefix}memory silent on/off</code> - 启用或禁用静默模式\n\n` +
                  `当前状态：${configDB.data.silentEnabled ? "✅ 已启用" : "❌ 未启用"}`,
            parseMode: "html"
          });
        }
      } else if (subCmd === "status" || subCmd === "s") {
        const memory = getMemoryUsage();
        const growth = getGrowthStatus(configDB.data, memory);
        const percentage = (memory.heapUsed / configDB.data.memoryThreshold) * 100;
        let statusEmoji = "🟢";
        let statusText = "正常";
        if (
          percentage > 90 ||
          memory.rss > configDB.data.rssThreshold ||
          growth.heapGrowthExceeded ||
          growth.rssGrowthExceeded
        ) {
          statusEmoji = "🔴";
          statusText = "危险";
        } else if (
          percentage > 70 ||
          memory.rss > configDB.data.rssThreshold * 0.7 ||
          (growth.heapGrowth != null && growth.heapGrowth > configDB.data.runtimeGrowthThreshold * 0.7) ||
          (growth.rssGrowth != null && growth.rssGrowth > configDB.data.runtimeGrowthThreshold * 0.7)
        ) {
          statusEmoji = "🟡";
          statusText = "警告";
        }
        let advice = "当前状态正常，无需处理。";
        if (!configDB.data.leakfixEnabled) {
          advice = `建议先使用 <code>${mainPrefix}memory on</code> 开启保护。`;
        } else if (statusText === "危险") {
          advice = `建议尽快观察日志；如仍持续升高，可手动执行 <code>${mainPrefix}reload</code> 或直接重启程序。`;
        } else if (statusText === "警告") {
          advice = `建议继续观察；如果上涨持续，可执行 <code>${mainPrefix}memory reset</code> 重新记基线，或用 <code>${mainPrefix}reload</code> 整理内存。`;
        }
        await msg.edit({
          text: `📊 <b>Memory优化状态</b>\n\n` +
                `🧩 功能：${configDB.data.leakfixEnabled ? "✅ 已启用" : "❌ 未启用"}\n` +
                `🔕 静默模式：${configDB.data.silentEnabled ? "✅ 已启用" : "❌ 未启用"}\n` + 
                `🚦 状态：${statusEmoji} <code>${statusText}</code>\n` +
                `📝 记录方式：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
                `📦 当前使用：\n` +
                `• 内存：<code>${memory.heapUsed.toFixed(2)} MB</code>\n` +
                `• 总内存：<code>${memory.rss.toFixed(2)} MB</code>\n\n` +
                `🛡️ 保护阈值：\n` +
                `• 内存：<code>${configDB.data.memoryThreshold} MB</code>\n` +
                `• 总内存：<code>${configDB.data.rssThreshold} MB</code>\n` +
                `• 增长：<code>${configDB.data.runtimeGrowthThreshold} MB</code>\n\n` +
                `📈 从基线开始增长：\n` +
                `• 内存：<code>${formatMb(growth.heapGrowth)}</code>\n` +
                `• 总内存：<code>${formatMb(growth.rssGrowth)}</code>\n\n` +
                `💡 建议动作：\n• ${advice}`,
          parseMode: "html"
        });
      } else {
        await msg.edit({ text: HELP_TEXT, parseMode: "html" });
      }
    }
  };
}

export default new ReloadPlugin();
