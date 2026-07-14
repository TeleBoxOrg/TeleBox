/**
 * 版本切换插件 (teleproto/gramjs)
 *
 * 命令：
 *   .switch go       — 切到另一个版本（session 直转，不重新登录）
 *   .switch status   — 查看状态
 *
 * 两边互切都用 go；不需要 revert。
 * Session：@mtcute/convert 离线互转。
 * 插件：目标版本有的会安装并合并配置；没有的会归档保存。
 */
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import {
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
} from "@utils/versionSwitchState";
import type { TeleBoxVersion } from "@utils/versionSwitchState";
import fs from "fs";
import path from "path";
import {
  resolveRepoRoot,
  spawnTsxDetached,
} from "@utils/versionSwitchPaths";
import { markSwitchInProgress, clearSwitchInProgress, 
  resolveTeleprotoChatId,
  readProgressSnapshot,
  clearProgressSnapshot,
} from "@utils/versionSwitchProgress";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const EMOJI: Record<string, string> = {
  teleproto: "🟦",
  mtcute: "🟧",
};

function label(v: TeleBoxVersion): string {
  return v === "teleproto" ? "TeleBox Classic" : "TeleBox-Next";
}

function detectCurrentVersion(): TeleBoxVersion {
  return "teleproto";
}

function hasTeleprotoNativeSession(): boolean {
  try {
    const configPath = path.join(resolveRepoRoot("teleproto"), "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      session?: string;
    };
    return Boolean(config.session && String(config.session).trim().length > 10);
  } catch {
    return false;
  }
}

const T = {
  help: () =>
    [
      `**🔄 版本切换**`,
      ``,
      `在 **TeleBox Classic** 和 **TeleBox-Next** 之间切换。`,
      `session 直接转换，**不用重新登录**。`,
      `两版都放在原安装目录下：telebox/telebox-classic 与 telebox/telebox-next。`,
      ``,
      `**两个子命令：**`,
      ``,
      `**1. \`${mainPrefix}switch go\`**`,
      `• 立刻切到**另一个**版本`,
      `• 自动：转换 session → 同步插件/配置 → 重启目标版本`,
      `• 另一边没有的插件会归档到本机，不会丢`,
      `• bot 会短暂离线几秒，完成后本条消息会更新`,
      ``,
      `**2. \`${mainPrefix}switch status\`**`,
      `• 查看当前运行的是哪个版本`,
      `• 显示另一边版本名称`,
      `• 不切换，只看状态`,
      ``,
      `再切回去：再发一次 \`${mainPrefix}switch go\` 即可。`,
    ].join("\n"),

  status: (state: ReturnType<typeof loadSwitchState>) => {
    const current = detectCurrentVersion();
    const other: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const lines = [
      `**📊 版本状态**`,
      ``,
      `**当前运行：** ${EMOJI[current]} ${label(current)}`,
      `**另一边：** ${EMOJI[other]} ${label(other)}`,
      ``,
      `切过去：\`${mainPrefix}switch go\``,
      `再看状态：\`${mainPrefix}switch status\``,
    ];
    if (state.activeVersion) {
      lines.push(
        ``,
        `上次切换到：${EMOJI[state.activeVersion]} ${label(state.activeVersion)}`,
      );
    }
    return lines.join("\n");
  },

  goSwitching: (target: TeleBoxVersion) =>
    [
      `🚀 **正在切换到 ${EMOJI[target]} ${label(target)}**`,
      ``,
      `本条消息会**实时更新**每一步进度：`,
      `• 准备目标版本（首次会下载依赖，可能较久）`,
      `• 转换 session / 同步插件 / 合并配置`,
      `• 停止当前版本 → 启动目标版本`,
      ``,
      `切换过程中 bot 会短暂离线，进度会尽量实时更新。`,
    ].join("\n"),

  goNoSourceSession: () =>
    [
      `❌ 当前没有可用的 session`,
      ``,
      `请先正常登录当前版本，再发 \`${mainPrefix}switch go\`。`,
    ].join("\n"),

  legacyRemoved: () =>
    [
      `ℹ️ 现在只有两个命令：`,
      ``,
      `\`${mainPrefix}switch go\` — 切到另一个版本`,
      `\`${mainPrefix}switch status\` — 查看状态`,
      ``,
      `不用 login / code / pwd / revert。`,
    ].join("\n"),

  unknownSub: (sub: string) =>
    `不知道 \`${sub}\` 是什么命令。\n\n` + T.help(),
};

function spawnController(source: TeleBoxVersion, target: TeleBoxVersion): void {
  // Run controller from SOURCE edition (always installed + deps ready).
  // Target may not exist yet — controller prepares it with live progress.
  // Never spawn bare "npx" (ENOENT under PM2).
  const repoRoot = resolveRepoRoot(source);
  const logDir = DEFAULT_SWITCH_HOME;
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, "controller.log");
  const logFd = fs.openSync(logPath, "a");
  fs.writeSync(
    logFd,
    `\n==== switch ${source} → ${target} @ ${new Date().toISOString()} ====\n`,
  );
  const child = spawnTsxDetached(
    repoRoot,
    path.join(repoRoot, "src", "utils", "versionSwitchController.ts"),
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        SWITCH_SKIP_LOGIN: "0",
        SWITCH_SOURCE: source,
        SWITCH_TARGET: target,
      },
    },
  );
  child.on("exit", () => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
  });
  // Detach fully: parent must not wait, and PM2 must not track this tree.
  child.unref();
  try {
    if (child.pid) {
      fs.writeFileSync(
        path.join(logDir, "controller.pid"),
        String(child.pid),
        { mode: 0o600 },
      );
    }
  } catch { /* ignore */ }
  console.log(`[switch] controller spawned pid=${child.pid} log=${logPath} (setsid/out-of-tree)`);
}

const plugin = new (class extends Plugin {
  name = "switch";
  description = "版本切换：.switch go 直切另一版本（session 转换，插件配置迁移）";

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    switch: async (msg) => {
      const text = msg.message || "";
      const parts = text.split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();

      if (!sub || sub === "help") {
        await msg.edit({ text: T.help() });
        return;
      }
      if (sub === "status") {
        await msg.edit({ text: T.status(loadSwitchState(DEFAULT_SWITCH_HOME)) });
        return;
      }
      if (
        sub === "login" ||
        sub === "code" ||
        sub === "pwd" ||
        sub === "password" ||
        sub === "revert"
      ) {
        await msg.edit({ text: T.legacyRemoved() });
        return;
      }
      if (sub === "go") {
        await this.handleGo(msg);
        return;
      }
      await msg.edit({ text: T.unknownSub(sub) });
    },
  };

  private async handleGo(msg: Api.Message): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (!hasTeleprotoNativeSession()) {
      await msg.edit({ text: T.goNoSourceSession() });
      return;
    }

    await msg.edit({ text: T.goSwitching(target) });
    // msg.peerId is an Api.TypePeer object — never Number(peerId).
    const chatId = resolveTeleprotoChatId(msg);
    if (chatId == null || Math.abs(chatId) === 777000) {
      await msg.edit({
        text: "❌ 无法识别当前对话，请在私聊中对账号发 `.switch go` 重试。",
      });
      return;
    }
    clearProgressSnapshot(DEFAULT_SWITCH_HOME);
    markSwitchInProgress({ source: current, target, reason: "plugin-go" });
    state.pendingNotification = {
      chatId,
      msgId: msg.id,
      target,
    };
    state.pendingLogin = null;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);
    try {
      spawnController(current, target);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      clearSwitchInProgress();
      await msg.edit({
        text: [
          `❌ **无法启动切换**`,
          ``,
          message,
          ``,
          `会在原运行时目录下使用 telebox-classic / telebox-next 子目录；`,
          `没有的那一版会自动创建并下载。`,
        ].join("\n"),
      });
      return;
    }
    // Live progress: poll controller's progress.json and edit this message
    void pollSwitchProgress(msg, chatId, msg.id);
  }

  /**
   * Poll ~/.telebox-switch/progress.json until done/fail or source process stops.
   * Controller never opens a second MTProto session — avoids AUTH_KEY conflict.
   */
})();


async function pollSwitchProgress(
  msg: Api.Message,
  chatId: number,
  msgId: number,
): Promise<void> {
  const started = Date.now();
  const MAX_MS = 25 * 60 * 1000; // 25 min (clone+npm can be slow)
  const INTERVAL_MS = 1500;
  let lastText = "";
  let idleTicks = 0;

  while (Date.now() - started < MAX_MS) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const snap = readProgressSnapshot(DEFAULT_SWITCH_HOME);
    if (!snap) {
      idleTicks += 1;
      // Controller may take a moment to write first snapshot
      if (idleTicks > 20) break;
      continue;
    }
    idleTicks = 0;
    if (snap.text && snap.text !== lastText) {
      lastText = snap.text;
      try {
        await msg.edit({ text: snap.text });
      } catch (err) {
        // Message deleted / FLOOD / client dying during stop — stop polling
        console.warn("[switch] progress edit failed:", err);
        break;
      }
    }
    if (snap.failed || snap.done) break;
  }
}

export default plugin;
