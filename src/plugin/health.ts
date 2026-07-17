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
  if (mode === "manual") return "手动（只有你 reset 才改）";
  if (mode === "on-reload") return "每次重载插件后更新";
  return "打开保护时自动记录";
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
    reasons.push(`程序内存 ${memory.heapUsed.toFixed(2)} MB，超过上限 ${config.memoryThreshold} MB`);
  }
  if (memory.rss > config.rssThreshold) {
    reasons.push(`总占用 ${memory.rss.toFixed(2)} MB，超过上限 ${config.rssThreshold} MB`);
  }
  if (growth.heapGrowthExceeded) {
    reasons.push(`程序内存比起点多了 ${formatMb(growth.heapGrowth)}，超过涨幅上限 ${config.runtimeGrowthThreshold} MB`);
  }
  if (growth.rssGrowthExceeded) {
    reasons.push(`总占用比起点多了 ${formatMb(growth.rssGrowth)}，超过涨幅上限 ${config.runtimeGrowthThreshold} MB`);
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
  return `📊 <b>TeleBox 内存快照</b>

🧠 <b>程序内存（Heap）</b>
  • 正在用：<code>${memory.heapUsed.toFixed(2)} MB</code>
  • 已申请：<code>${memory.heapTotal.toFixed(2)} MB</code>
  • 使用率：<code>${((memory.heapUsed / memory.heapTotal) * 100).toFixed(1)}%</code>

💻 <b>系统占用（RSS，含进程整体）</b>
  • <code>${memory.rss.toFixed(2)} MB</code>

📎 其他：外部 <code>${memory.external.toFixed(2)} MB</code> · 缓冲 <code>${memory.arrayBuffers.toFixed(2)} MB</code>`;
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
    return { emoji: "🔴", text: "偏高，需要关注" };
  }
  if (
    percentage > 70 ||
    memory.rss > config.rssThreshold * 0.7 ||
    (growth.heapGrowth != null && growth.heapGrowth > config.runtimeGrowthThreshold * 0.7) ||
    (growth.rssGrowth != null && growth.rssGrowth > config.runtimeGrowthThreshold * 0.7)
  ) {
    return { emoji: "🟡", text: "略高，继续观察" };
  }
  return { emoji: "🟢", text: "正常，放心用" };
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
      `⚠️ <b>内存有点高，开始自动处理</b>\n\n` +
        `原因：\n• ${reasons.join("\n• ")}\n\n` +
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
          `✅ <b>内存已恢复正常</b>\n\n` +
            `已自动软重载，不用你手动操作。\n` +
            `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
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
          `⚠️ <b>软重载后内存仍偏高</b>\n\n` +
            `先不急着重启，再观察一会儿（${overThresholdStreak}/${hardNeed}）。\n` +
            `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
          config.silentEnabled,
        );
        return;
      }

      console.log("[Health] 仍超限且达到 hard streak，准备 process.exit");
      await notifyMe(
        `⚠️ <b>准备重启程序</b>\n\n` +
          `清理和软重载后内存还是偏高，马上整进程重启。\n` +
          `不用慌：PM2 会自动再拉起 TeleBox。\n` +
          `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
          `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
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
            `⚠️ <b>软重载失败，准备重启</b>\n\n自动整理没成功，将直接重启程序（PM2 会自动拉起）。`,
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

const HELP_TEXT = `🩺 <b>Health · 内存守护</b>

一句话：帮你盯着 TeleBox 吃了多少内存，偏高时自动收拾，尽量不打断正在做的事。

————————
📌 <b>新手怎么用（3 步）</b>
1. 发 <code>${mainPrefix}health</code> 看当前内存是否正常
2. 发 <code>${mainPrefix}memory on</code> 打开自动保护（默认是关的）
3. 想看详细状态发 <code>${mainPrefix}memory status</code>

————————
📖 <b>常用命令</b>
• <code>${mainPrefix}health</code>
  查看现在内存用了多少、是否安全
• <code>${mainPrefix}memory on</code> / <code>${mainPrefix}memory off</code>
  打开 / 关闭自动保护
• <code>${mainPrefix}memory status</code>
  看保护开没开、现在安不安全、系统建议你做什么
• <code>${mainPrefix}memory reset</code>
  把「对比起点」记成当前内存（适合刚清理完之后）
• <code>${mainPrefix}memory set safe</code>
  更敏感：内存稍高就处理（机器内存小推荐）
• <code>${mainPrefix}memory set normal</code>
  默认平衡（大多数人用这个）
• <code>${mainPrefix}memory set aggressive</code>
  更宽松：少打扰（插件很多、内存本来就高时用）
• <code>${mainPrefix}memory silent on</code> / <code>off</code>
  自动处理时要不要私信通知你（默认会通知「收藏夹/Saved Messages」）

————————
⚙️ <b>进阶（一般不用改）</b>
• <code>${mainPrefix}memory mode auto</code> — 打开保护时自动记起点
• <code>${mainPrefix}memory mode manual</code> — 只有你执行 reset 才改起点
• <code>${mainPrefix}memory mode reload</code> — 每次重载插件后改起点
• <code>${mainPrefix}memory set heap 150</code> — 程序内存上限（MB）
• <code>${mainPrefix}memory set rss 512</code> — 总占用上限（MB）
• <code>${mainPrefix}memory set growth 120</code> — 相对起点涨幅上限（MB）

————————
🧠 <b>自动保护怎么工作（人话）</b>
1. 大约每 10 分钟检查一次
2. 要连续好几次都偏高才动手（避免误报）
3. 如果你正在跑任务，会先等一等，尽量不打断
4. 处理顺序：先尝试清理 → 再软重载 → 实在不行才整进程重启（PM2 会自动拉起）
5. 版本切换 / 正在重载时，绝对不会乱动

💡 不知道从哪开始？先发 <code>${mainPrefix}memory on</code>，再发 <code>${mainPrefix}memory status</code> 看一眼就行。`;

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
      description: "定时检查内存：偏高时自动清理，尽量不打断正在进行的任务",
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
          `🚦 <b>总体：</b>${level.emoji} ${level.text}\n` +
          `🛡 <b>自动保护：</b>${configDB.data.leakfixEnabled ? "✅ 已打开" : "❌ 未打开（发 " + mainPrefix + "memory on 可开启）"}\n` +
          `🧵 <b>正在进行的任务：</b><code>${busy}</code> 个\n` +
          `📈 <b>连续偏高次数：</b><code>${overThresholdStreak}</code>\n\n` +
          `💡 详细状态：<code>${mainPrefix}memory status</code> · 帮助：<code>${mainPrefix}memory</code>`;
        await msg.edit({ text: fullText, parseMode: "html" });
      } catch (error) {
        console.error("[Health] 命令失败:", error);
        await msg.edit({
          text: `❌ 没能读到内存信息：${htmlEscape(error instanceof Error ? error.message : String(error))}`,
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
            `✅ <b>自动内存保护已打开</b>\n\n` +
            `之后大约每 10 分钟检查一次。\n` +
            `• 连续多次偏高才会处理（避免误报）\n` +
            `• 有任务在跑时会先等一等，尽量不打断你\n` +
            `• 对比起点：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
            `查看状态：<code>${mainPrefix}memory status</code>`,
          parseMode: "html",
        });
      } else if (subCmd === "off") {
        configDB.data.leakfixEnabled = false;
        overThresholdStreak = 0;
        await configDB.write();
        await msg.edit({
          text: `❌ <b>自动内存保护已关闭</b>\n\n系统不会再自动清理/重启。\n需要时再发 <code>${mainPrefix}memory on</code> 打开。`,
          parseMode: "html",
        });
      } else if (subCmd === "set") {
        const target = parts[2]?.toLowerCase();
        const threshold = parseInt(parts[3], 10);

        if (target && ["safe", "normal", "aggressive"].includes(target)) {
          applyMemoryPreset(configDB.data, target as "safe" | "normal" | "aggressive");
          await configDB.write();
          await msg.edit({
            text: `✅ <b>已切换保护强度</b>：<code>${target}</code>\n查看：<code>${mainPrefix}memory status</code>`,
            parseMode: "html",
          });
          return;
        }

        if (isNaN(threshold) || threshold <= 0) {
          await msg.edit({
            text:
              `❌ 参数不对，可以这样用：\n\n` +
              `一键强度：\n` +
              `• <code>${mainPrefix}memory set safe</code> — 更敏感\n` +
              `• <code>${mainPrefix}memory set normal</code> — 默认\n` +
              `• <code>${mainPrefix}memory set aggressive</code> — 更宽松\n\n` +
              `自定义上限（单位 MB）：\n` +
              `• <code>${mainPrefix}memory set heap 150</code> — 程序内存\n` +
              `• <code>${mainPrefix}memory set rss 512</code> — 总占用\n` +
              `• <code>${mainPrefix}memory set growth 120</code> — 相对起点涨幅`,
            parseMode: "html",
          });
          return;
        }

        if (target === "heap") configDB.data.memoryThreshold = threshold;
        else if (target === "rss") configDB.data.rssThreshold = threshold;
        else if (target === "growth") configDB.data.runtimeGrowthThreshold = threshold;
        else {
          await msg.edit({
            text: `❌ 只支持 heap（程序内存）/ rss（总占用）/ growth（涨幅）\n例：<code>${mainPrefix}memory set heap 150</code>`,
            parseMode: "html",
          });
          return;
        }
        await configDB.write();
        await msg.edit({
          text: `✅ 已更新：<code>${target}</code> = <code>${threshold} MB</code>\n查看：<code>${mainPrefix}memory status</code>`,
          parseMode: "html",
        });
      } else if (subCmd === "reset") {
        updateMemoryBaseline(configDB.data, getMemoryUsage());
        overThresholdStreak = 0;
        await configDB.write();
        await msg.edit({
          text: `✅ 已把当前内存记为新的对比起点\n之后「涨了多少」会从现在重新算。`,
          parseMode: "html",
        });
      } else if (subCmd === "mode") {
        const mode = parseBaselineMode(parts[2]?.toLowerCase());
        if (!mode) {
          await msg.edit({
            text: `❌ 请选择：\n• <code>${mainPrefix}memory mode auto</code> — 打开保护时自动记\n• <code>${mainPrefix}memory mode manual</code> — 只有 reset 才改\n• <code>${mainPrefix}memory mode reload</code> — 每次重载后改`,
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
          text: `✅ 对比起点方式已更新：${formatBaselineMode(mode)}\n可用 <code>${mainPrefix}memory reset</code> 手动重记。`,
          parseMode: "html",
        });
      } else if (subCmd === "silent") {
        const silentCmd = parts[2]?.toLowerCase() || "help";
        if (silentCmd === "on" || silentCmd === "off") {
          configDB.data.silentEnabled = silentCmd === "on";
          await configDB.write();
          await msg.edit({
            text: `${configDB.data.silentEnabled ? "🔕 已开启静默：自动处理时不再私信你" : "🔔 已关闭静默：自动处理时会私信通知你"}`,
            parseMode: "html",
          });
        } else {
          await msg.edit({
            text: `🔕 通知设置：${configDB.data.silentEnabled ? "静默（不私信）" : "会私信通知"}\n• <code>${mainPrefix}memory silent on</code> — 不通知\n• <code>${mainPrefix}memory silent off</code> — 通知我`,
            parseMode: "html",
          });
        }
      } else if (subCmd === "status" || subCmd === "s") {
        const memory = getMemoryUsage();
        const growth = getGrowthStatus(configDB.data, memory);
        const level = statusLevel(configDB.data, memory, growth);
        const busy = getBusyTaskCount();
        let advice = "一切正常，不用管。";
        if (!configDB.data.leakfixEnabled) {
          advice = `建议先发 <code>${mainPrefix}memory on</code> 打开自动保护。`;
        } else if (level.text.includes("偏高，需要关注")) {
          advice = busy > 0
            ? `现在有 ${busy} 个任务在跑，系统会先等任务结束再处理，尽量不打断你。`
            : `系统会按策略自动清理；你也可以手动发 <code>${mainPrefix}reload</code> 软重载。`;
        } else if (level.text.includes("略高")) {
          advice = `先观察即可。若刚清理过，可发 <code>${mainPrefix}memory reset</code> 重记对比起点。`;
        }
        await msg.edit({
          text:
            `📊 <b>内存守护状态</b>\n\n` +
            `🛡 自动保护：${configDB.data.leakfixEnabled ? "✅ 已打开" : "❌ 未打开"}\n` +
            `🔔 私信通知：${configDB.data.silentEnabled ? "关闭（静默）" : "开启"}\n` +
            `🚦 总体：${level.emoji} ${level.text}\n` +
            `🧵 正在进行的任务：<code>${busy}</code> 个\n` +
            `📈 连续偏高次数：<code>${overThresholdStreak}</code>\n` +
            `📝 对比起点方式：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
            `📦 <b>现在用了多少</b>\n` +
            `• 程序内存：<code>${memory.heapUsed.toFixed(2)} MB</code>（上限 ${configDB.data.memoryThreshold}）\n` +
            `• 总占用：<code>${memory.rss.toFixed(2)} MB</code>（上限 ${configDB.data.rssThreshold}）\n` +
            `• 相对起点涨了：程序 <code>${formatMb(growth.heapGrowth)}</code> / 总 <code>${formatMb(growth.rssGrowth)}</code>（涨幅上限 ${configDB.data.runtimeGrowthThreshold} MB）\n\n` +
            `💡 <b>建议</b>：${advice}\n\n` +
            `帮助：<code>${mainPrefix}memory</code>`,
          parseMode: "html",
        });
      } else if (subCmd === "baseline") {
        // compat with old subcommands
        const action = parts[2]?.toLowerCase() || "status";
        if (action === "reset") {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
          await configDB.write();
          await msg.edit({ text: `✅ 已把当前内存记为新的对比起点`, parseMode: "html" });
        } else {
          await msg.edit({
            text:
              `📏 <b>对比起点（基线）</b>\n\n` +
              `• 程序内存起点：<code>${formatMb(configDB.data.baselineHeapUsed)}</code>\n` +
              `• 总占用起点：<code>${formatMb(configDB.data.baselineRss)}</code>\n` +
              `• 记录方式：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
              `重记：<code>${mainPrefix}memory reset</code>`,
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
