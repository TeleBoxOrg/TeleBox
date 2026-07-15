import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { JSONFilePreset } from "lowdb/node";
import {
  getCurrentGenerationContext,
  isRuntimeTransitioning,
  reloadRuntime,
  tryGetCurrentGenerationContext,
} from "@utils/runtimeManager";
import { htmlEscape } from "@utils/htmlEscape";
import { isSwitchInProgress } from "@utils/versionSwitchProgress";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const assetsDir = createDirectoryInAssets("health", ["reload"]);
const configPath = path.join(assetsDir, "config.json");
const pendingExitTimers = new Set<ReturnType<typeof setTimeout>>();

/** Consecutive over-threshold samples required before soft/hard action. */
const DEFAULT_STREAK_SOFT = 2;
const DEFAULT_STREAK_HARD = 3;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_BUSY_DEFER_MS = 5 * 60 * 1000;
const DEFAULT_GC_COOLDOWN_MS = 60 * 1000;

interface HealthConfig {
  leakfixEnabled: boolean;
  memoryThreshold: number;
  rssThreshold: number;
  runtimeGrowthThreshold: number;
  baselineHeapUsed: number | null;
  baselineRss: number | null;
  baselineMode: "on-enable" | "manual" | "on-reload";
  silentEnabled: boolean;
  /** Consecutive samples over soft threshold before reloadRuntime */
  softStreak: number;
  /** Consecutive samples still over after soft/gc before process exit */
  hardStreak: number;
  /** Min interval between disruptive actions (reload/exit) */
  actionCooldownMs: number;
  /** How long to keep deferring when tasks are busy */
  busyDeferMaxMs: number;
  lastActionAt: number | null;
  /** Schema for config migration from reload-era */
  configVersion: number;
}

const DEFAULT_CONFIG: HealthConfig = {
  leakfixEnabled: false,
  memoryThreshold: 150,
  rssThreshold: 512,
  runtimeGrowthThreshold: 120,
  baselineHeapUsed: null,
  baselineRss: null,
  baselineMode: "on-enable",
  silentEnabled: false,
  softStreak: DEFAULT_STREAK_SOFT,
  hardStreak: DEFAULT_STREAK_HARD,
  actionCooldownMs: DEFAULT_COOLDOWN_MS,
  busyDeferMaxMs: DEFAULT_BUSY_DEFER_MS,
  lastActionAt: null,
  configVersion: 2,
};

// In-memory runtime state (not persisted)
let overThresholdStreak = 0;
let busyDeferSince: number | null = null;
let lastGcAt = 0;
let lastSample: ReturnType<typeof getMemoryUsage> | null = null;

async function initConfig() {
  const db = await JSONFilePreset<HealthConfig>(configPath, { ...DEFAULT_CONFIG });
  // Migrate missing fields from reload-era configs
  let dirty = false;
  for (const [k, v] of Object.entries(DEFAULT_CONFIG) as [keyof HealthConfig, HealthConfig[keyof HealthConfig]][]) {
    if (db.data[k] === undefined) {
      (db.data as any)[k] = v;
      dirty = true;
    }
  }
  if ((db.data.configVersion ?? 0) < 2) {
    db.data.configVersion = 2;
    dirty = true;
  }
  if (dirty) await db.write();
  return db;
}

function formatMb(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "未记录";
  return `${value.toFixed(2)} MB`;
}

function updateMemoryBaseline(config: HealthConfig, memory: ReturnType<typeof getMemoryUsage>): void {
  config.baselineHeapUsed = memory.heapUsed;
  config.baselineRss = memory.rss;
}

function formatBaselineMode(mode: HealthConfig["baselineMode"]): string {
  if (mode === "manual") return "手动";
  if (mode === "on-reload") return "每次重载后自动更新";
  return "开启时自动记录";
}

function parseBaselineMode(input?: string): HealthConfig["baselineMode"] | null {
  if (!input) return null;
  if (input === "auto" || input === "on-enable") return "on-enable";
  if (input === "reload" || input === "on-reload") return "on-reload";
  if (input === "manual") return "manual";
  return null;
}

function applyMemoryPreset(config: HealthConfig, preset: "safe" | "normal" | "aggressive"): void {
  if (preset === "safe") {
    config.memoryThreshold = 120;
    config.rssThreshold = 420;
    config.runtimeGrowthThreshold = 80;
    config.softStreak = 2;
    config.hardStreak = 3;
    return;
  }
  if (preset === "aggressive") {
    config.memoryThreshold = 220;
    config.rssThreshold = 768;
    config.runtimeGrowthThreshold = 180;
    config.softStreak = 3;
    config.hardStreak = 4;
    return;
  }
  config.memoryThreshold = 150;
  config.rssThreshold = 512;
  config.runtimeGrowthThreshold = 120;
  config.softStreak = DEFAULT_STREAK_SOFT;
  config.hardStreak = DEFAULT_STREAK_HARD;
}

function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed / 1024 / 1024,
    heapTotal: usage.heapTotal / 1024 / 1024,
    rss: usage.rss / 1024 / 1024,
    external: usage.external / 1024 / 1024,
    arrayBuffers: usage.arrayBuffers / 1024 / 1024,
  };
}

function getGrowthStatus(config: HealthConfig, memory: ReturnType<typeof getMemoryUsage>) {
  const heapGrowth =
    config.baselineHeapUsed == null ? null : memory.heapUsed - config.baselineHeapUsed;
  const rssGrowth =
    config.baselineRss == null ? null : memory.rss - config.baselineRss;
  const growthThreshold = config.runtimeGrowthThreshold;
  return {
    heapGrowth,
    rssGrowth,
    growthThreshold,
    heapGrowthExceeded: heapGrowth != null && heapGrowth > growthThreshold,
    rssGrowthExceeded: rssGrowth != null && rssGrowth > growthThreshold,
  };
}

function collectReasons(config: HealthConfig, memory: ReturnType<typeof getMemoryUsage>) {
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
  return { reasons, growth };
}

function getBusyTaskCount(): number {
  const ctx = tryGetCurrentGenerationContext();
  if (!ctx) return 0;
  try {
    return ctx.getTrackedTaskCount();
  } catch {
    return 0;
  }
}

function tryGlobalGc(): boolean {
  const now = Date.now();
  if (now - lastGcAt < DEFAULT_GC_COOLDOWN_MS) return false;
  const g = (global as typeof globalThis & { gc?: () => void }).gc;
  if (typeof g !== "function") return false;
  try {
    g();
    lastGcAt = now;
    console.log("[Health] ran global.gc()");
    return true;
  } catch (e) {
    console.warn("[Health] global.gc failed:", e);
    return false;
  }
}

function scheduleTrackedTimeout(
  callback: () => void | Promise<void>,
  delay: number,
): ReturnType<typeof setTimeout> {
  let timer: ReturnType<typeof setTimeout>;
  const context = getCurrentGenerationContext();
  timer = context.setTimeout(() => {
    pendingExitTimers.delete(timer);
    const task = Promise.resolve(callback());
    context.trackTask(task, { label: "health:scheduled-timeout" });
    task.catch((error) => {
      console.error("[Health] Scheduled timeout failed:", error);
    });
  }, delay, { label: "health:scheduled-timeout" });
  pendingExitTimers.add(timer);
  return timer;
}

async function notifyMe(htmlText: string, silent: boolean): Promise<void> {
  if (silent) return;
  try {
    const client = await getGlobalClient();
    await client.sendMessage("me", { message: htmlText, parseMode: "html" });
  } catch (e) {
    console.warn("[Health] notify me failed:", e);
  }
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

function statusLevel(
  config: HealthConfig,
  memory: ReturnType<typeof getMemoryUsage>,
  growth: ReturnType<typeof getGrowthStatus>,
): { emoji: string; text: string } {
  const percentage = (memory.heapUsed / config.memoryThreshold) * 100;
  if (
    percentage > 90 ||
    memory.rss > config.rssThreshold ||
    growth.heapGrowthExceeded ||
    growth.rssGrowthExceeded
  ) {
    return { emoji: "🔴", text: "危险" };
  }
  if (
    percentage > 70 ||
    memory.rss > config.rssThreshold * 0.7 ||
    (growth.heapGrowth != null && growth.heapGrowth > config.runtimeGrowthThreshold * 0.7) ||
    (growth.rssGrowth != null && growth.rssGrowth > config.runtimeGrowthThreshold * 0.7)
  ) {
    return { emoji: "🟡", text: "警告" };
  }
  return { emoji: "🟢", text: "正常" };
}

/**
 * Smart memory protection:
 * 1) skip if switch / runtime transition
 * 2) require consecutive over-threshold samples (streak)
 * 3) prefer GC → wait for busy tasks → reloadRuntime → exit only as last resort
 * 4) cooldown between disruptive actions
 */
async function healthMonitorTask() {
  try {
    const configDB = await initConfig();
    const config = configDB.data;
    if (!config.leakfixEnabled) return;

    if (isSwitchInProgress()) {
      console.log("[Health] switch 进行中，跳过保护动作");
      return;
    }
    if (isRuntimeTransitioning()) {
      console.log("[Health] runtime 切换中，跳过保护动作");
      return;
    }

    const memory = getMemoryUsage();
    lastSample = memory;
    if (config.baselineHeapUsed == null || config.baselineRss == null) {
      updateMemoryBaseline(config, memory);
      await configDB.write();
    }

    const { reasons, growth } = collectReasons(config, memory);

    if (reasons.length === 0) {
      overThresholdStreak = 0;
      busyDeferSince = null;
      console.log(
        `[Health] 正常: Heap ${memory.heapUsed.toFixed(2)}MB / ${config.memoryThreshold}MB, RSS ${memory.rss.toFixed(2)}MB / ${config.rssThreshold}MB, 任务 ${getBusyTaskCount()}`,
      );
      return;
    }

    overThresholdStreak += 1;
    const softNeed = config.softStreak ?? DEFAULT_STREAK_SOFT;
    const hardNeed = config.hardStreak ?? DEFAULT_STREAK_HARD;
    console.log(
      `[Health] 超限采样 ${overThresholdStreak}/${softNeed}(soft)/${hardNeed}(hard): ${reasons.join("; ")}`,
    );

    // Soft path: GC only on first over-threshold sample(s)
    if (overThresholdStreak < softNeed) {
      tryGlobalGc();
      return;
    }

    // Cooldown: don't thrash reload/exit
    const now = Date.now();
    const cooldown = config.actionCooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (config.lastActionAt != null && now - config.lastActionAt < cooldown) {
      const left = Math.ceil((cooldown - (now - config.lastActionAt)) / 60000);
      console.log(`[Health] 动作冷却中（约 ${left} 分钟后可再动作），本轮仅记录`);
      return;
    }

    // Busy tasks: do not abort mid-work
    const busy = getBusyTaskCount();
    if (busy > 0) {
      if (busyDeferSince == null) busyDeferSince = now;
      const deferredFor = now - busyDeferSince;
      const maxDefer = config.busyDeferMaxMs ?? DEFAULT_BUSY_DEFER_MS;
      console.log(
        `[Health] ${busy} 个进行中任务，推迟保护（已推迟 ${(deferredFor / 1000).toFixed(0)}s / 上限 ${(maxDefer / 1000).toFixed(0)}s）`,
      );
      if (deferredFor < maxDefer) {
        tryGlobalGc();
        return;
      }
      console.warn("[Health] 忙碌推迟超时，仍继续保护链路（可能打断长任务）");
    } else {
      busyDeferSince = null;
    }

    await notifyMe(
      `⚠️ <b>内存监控告警</b>\n\n` +
        `触发原因：\n• ${reasons.join("\n• ")}\n\n` +
        `当前：Heap <code>${memory.heapUsed.toFixed(2)} MB</code> · RSS <code>${memory.rss.toFixed(2)} MB</code>\n` +
        `连续超限：<code>${overThresholdStreak}</code> 次 · 进行中任务：<code>${busy}</code>\n\n` +
        `将优先 GC → 重建 Runtime；仍超限才重启进程。`,
      config.silentEnabled,
    );

    // Soft recover: GC then reloadRuntime
    tryGlobalGc();
    let reloaded = false;
    try {
      const runtime = await reloadRuntime();
      reloaded = true;
      const after = getMemoryUsage();
      const afterReasons = collectReasons(config, after).reasons;

      if (config.baselineMode === "on-reload") {
        updateMemoryBaseline(config, after);
      }
      config.lastActionAt = Date.now();
      await configDB.write();

      if (afterReasons.length === 0) {
        overThresholdStreak = 0;
        busyDeferSince = null;
        await notifyMe(
          `✅ <b>Health 内存优化</b>\n\n` +
            `已自动重建 Runtime，内存恢复安全范围。\n` +
            `• Heap：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• RSS：<code>${after.rss.toFixed(2)} MB</code>`,
          config.silentEnabled,
        );
        return;
      }

      // Hard path: still high after soft — need more streak before exit
      if (overThresholdStreak < hardNeed) {
        console.log(
          `[Health] reload 后仍超限，等待更多采样 (${overThresholdStreak}/${hardNeed}) 再 exit`,
        );
        await notifyMe(
          `⚠️ <b>Health 内存优化</b>\n\n` +
            `Runtime 重建后仍偏高，将继续观察（${overThresholdStreak}/${hardNeed}）。\n` +
            `• Heap：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• RSS：<code>${after.rss.toFixed(2)} MB</code>`,
          config.silentEnabled,
        );
        return;
      }

      console.log("[Health] 仍超限且达到 hard streak，准备 process.exit");
      await notifyMe(
        `⚠️ <b>Health 内存优化</b>\n\n` +
          `整理后仍持续超限，即将重启整个程序（PM2 拉起）。\n` +
          `• Heap：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
          `• RSS：<code>${after.rss.toFixed(2)} MB</code>`,
        config.silentEnabled,
      );
      config.lastActionAt = Date.now();
      await configDB.write();
      scheduleTrackedTimeout(() => process.exit(0), 1500);
    } catch (reloadError) {
      console.error("[Health] reloadRuntime 失败:", reloadError);
      if (!reloaded) {
        if (overThresholdStreak >= hardNeed) {
          await notifyMe(
            `⚠️ <b>Health 内存优化</b>\n\n自动重建 Runtime 失败，准备直接重启进程。`,
            config.silentEnabled,
          );
          config.lastActionAt = Date.now();
          await configDB.write();
          scheduleTrackedTimeout(() => process.exit(0), 1500);
        } else {
          console.log("[Health] reload 失败但 hard streak 未满，下周期再试");
        }
      }
    }
  } catch (error) {
    console.error("[Health] 定时任务失败:", error);
  }
}

const HELP_TEXT = `🩺 Health - 智能内存与运行健康

🔧 命令:
• <code>${mainPrefix}health</code> - 内存与任务快照
• <code>${mainPrefix}memory on/off</code> - 启用/关闭自动保护
• <code>${mainPrefix}memory status</code> - 状态 / 建议
• <code>${mainPrefix}memory reset</code> - 重记基线
• <code>${mainPrefix}memory mode [auto/manual/reload]</code> - 基线策略
• <code>${mainPrefix}memory set [safe/normal/aggressive]</code> - 预设
• <code>${mainPrefix}memory set heap|rss|growth [MB]</code> - 阈值
• <code>${mainPrefix}memory silent on/off</code> - 静默通知

🧠 智能策略（生产）:
1. 连续多次超限才动作（默认 soft ${DEFAULT_STREAK_SOFT} / hard ${DEFAULT_STREAK_HARD}）
2. 有进行中任务时优先推迟，避免打断业务
3. 先 <code>gc</code>（若可用）→ <code>reloadRuntime</code> → 仍超限再 <code>exit</code>
4. 动作冷却（默认 ${DEFAULT_COOLDOWN_MS / 60000} 分钟）防抖动
5. version switch / runtime 切换中永不动作`;

class HealthPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingExitTimers) {
      clearTimeout(timer);
    }
    pendingExitTimers.clear();
  }

  description = HELP_TEXT;

  cronTasks = {
    healthMonitor: {
      // Every 10 minutes — denser than hourly so streak can accumulate without being too aggressive
      cron: "*/10 * * * *",
      description: "智能内存监控：连续超限 → GC → 等任务 → reload → exit",
      handler: async () => await healthMonitorTask(),
    },
  };

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    health: async (msg) => {
      try {
        const configDB = await initConfig();
        const memory = getMemoryUsage();
        const growth = getGrowthStatus(configDB.data, memory);
        const level = statusLevel(configDB.data, memory, growth);
        const busy = getBusyTaskCount();
        const fullText =
          `${formatMemoryInfo(memory)}\n\n` +
          `<b>状态：</b> ${level.emoji} ${level.text}\n` +
          `<b>进行中任务：</b> <code>${busy}</code>\n` +
          `<b>超限连续采样：</b> <code>${overThresholdStreak}</code>\n` +
          `<b>自动保护：</b> ${configDB.data.leakfixEnabled ? "✅ 开" : "❌ 关"}`;
        await msg.edit({ text: fullText, parseMode: "html" });
      } catch (error) {
        console.error("[Health] 命令失败:", error);
        await msg.edit({
          text: `❌ 获取健康信息失败：${htmlEscape(error instanceof Error ? error.message : String(error))}`,
          parseMode: "html",
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
        overThresholdStreak = 0;
        busyDeferSince = null;
        await configDB.write();
        await msg.edit({
          text:
            `✅ <b>Memory 保护已启用</b>\n\n` +
            `连续超限才会动作；有任务时会推迟。\n` +
            `📝 基线：${formatBaselineMode(configDB.data.baselineMode)}`,
          parseMode: "html",
        });
      } else if (subCmd === "off") {
        configDB.data.leakfixEnabled = false;
        overThresholdStreak = 0;
        await configDB.write();
        await msg.edit({
          text: "❌ <b>Memory 保护已关闭</b>",
          parseMode: "html",
        });
      } else if (subCmd === "set") {
        const target = parts[2]?.toLowerCase();
        const threshold = parseInt(parts[3], 10);

        if (target && ["safe", "normal", "aggressive"].includes(target)) {
          applyMemoryPreset(configDB.data, target as "safe" | "normal" | "aggressive");
          await configDB.write();
          await msg.edit({
            text: `✅ 已切换预设 <code>${target}</code>`,
            parseMode: "html",
          });
          return;
        }

        if (isNaN(threshold) || threshold <= 0) {
          await msg.edit({
            text:
              `❌ 参数错误\n` +
              `预设：<code>${mainPrefix}memory set safe|normal|aggressive</code>\n` +
              `阈值：<code>${mainPrefix}memory set heap|rss|growth [MB]</code>`,
            parseMode: "html",
          });
          return;
        }

        if (target === "heap") configDB.data.memoryThreshold = threshold;
        else if (target === "rss") configDB.data.rssThreshold = threshold;
        else if (target === "growth") configDB.data.runtimeGrowthThreshold = threshold;
        else {
          await msg.edit({
            text: `❌ 未知类型，支持 heap / rss / growth`,
            parseMode: "html",
          });
          return;
        }
        await configDB.write();
        await msg.edit({
          text: `✅ <code>${target}</code> = <code>${threshold} MB</code>`,
          parseMode: "html",
        });
      } else if (subCmd === "reset") {
        updateMemoryBaseline(configDB.data, getMemoryUsage());
        overThresholdStreak = 0;
        await configDB.write();
        await msg.edit({
          text: `✅ 已重记当前内存为基线`,
          parseMode: "html",
        });
      } else if (subCmd === "mode") {
        const mode = parseBaselineMode(parts[2]?.toLowerCase());
        if (!mode) {
          await msg.edit({
            text: `❌ 可用：auto / manual / reload`,
            parseMode: "html",
          });
          return;
        }
        configDB.data.baselineMode = mode;
        if (mode === "on-enable" && configDB.data.leakfixEnabled) {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
        }
        await configDB.write();
        await msg.edit({
          text: `✅ 基线方式：${formatBaselineMode(mode)}`,
          parseMode: "html",
        });
      } else if (subCmd === "silent") {
        const silentCmd = parts[2]?.toLowerCase() || "help";
        if (silentCmd === "on" || silentCmd === "off") {
          configDB.data.silentEnabled = silentCmd === "on";
          await configDB.write();
          await msg.edit({
            text: `✅ 静默模式：${configDB.data.silentEnabled ? "开" : "关"}`,
            parseMode: "html",
          });
        } else {
          await msg.edit({
            text: `🔕 静默：${configDB.data.silentEnabled ? "开" : "关"}\n<code>${mainPrefix}memory silent on|off</code>`,
            parseMode: "html",
          });
        }
      } else if (subCmd === "status" || subCmd === "s") {
        const memory = getMemoryUsage();
        const growth = getGrowthStatus(configDB.data, memory);
        const level = statusLevel(configDB.data, memory, growth);
        const busy = getBusyTaskCount();
        let advice = "当前正常，无需处理。";
        if (!configDB.data.leakfixEnabled) {
          advice = `建议 <code>${mainPrefix}memory on</code> 开启保护。`;
        } else if (level.text === "危险") {
          advice = busy > 0
            ? `有 ${busy} 个任务进行中，自动保护会推迟；结束后会再评估。`
            : `将按 streak 策略 GC → reload → exit；也可手动 <code>${mainPrefix}reload</code>。`;
        } else if (level.text === "警告") {
          advice = `继续观察；可用 <code>${mainPrefix}memory reset</code> 重记基线。`;
        }
        await msg.edit({
          text:
            `📊 <b>Health / Memory 状态</b>\n\n` +
            `🧩 保护：${configDB.data.leakfixEnabled ? "✅" : "❌"} · 静默：${configDB.data.silentEnabled ? "✅" : "❌"}\n` +
            `🚦 ${level.emoji} <code>${level.text}</code> · 任务 <code>${busy}</code> · streak <code>${overThresholdStreak}</code>\n` +
            `📝 基线：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
            `📦 当前 Heap <code>${memory.heapUsed.toFixed(2)}</code> / RSS <code>${memory.rss.toFixed(2)}</code> MB\n` +
            `🛡️ 阈值 Heap <code>${configDB.data.memoryThreshold}</code> / RSS <code>${configDB.data.rssThreshold}</code> / 增长 <code>${configDB.data.runtimeGrowthThreshold}</code>\n` +
            `📈 增长 Heap <code>${formatMb(growth.heapGrowth)}</code> / RSS <code>${formatMb(growth.rssGrowth)}</code>\n\n` +
            `💡 ${advice}`,
          parseMode: "html",
        });
      } else if (subCmd === "baseline") {
        // compat with old subcommands
        const action = parts[2]?.toLowerCase() || "status";
        if (action === "reset") {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
          await configDB.write();
          await msg.edit({ text: `✅ 基线已重置`, parseMode: "html" });
        } else {
          await msg.edit({
            text:
              `📏 Heap 基线 <code>${formatMb(configDB.data.baselineHeapUsed)}</code>\n` +
              `RSS 基线 <code>${formatMb(configDB.data.baselineRss)}</code>\n` +
              `方式：${formatBaselineMode(configDB.data.baselineMode)}`,
            parseMode: "html",
          });
        }
      } else {
        await msg.edit({ text: HELP_TEXT, parseMode: "html" });
      }
    },
  };
}

export default new HealthPlugin();

/** Allow reload plugin (or others) to refresh baseline after manual reload */
export async function noteReloadCompleted(): Promise<void> {
  try {
    const configDB = await initConfig();
    if (configDB.data.baselineMode === "on-reload") {
      updateMemoryBaseline(configDB.data, getMemoryUsage());
      await configDB.write();
    }
    overThresholdStreak = 0;
    busyDeferSince = null;
  } catch (e) {
    console.warn("[Health] noteReloadCompleted:", e);
  }
}
