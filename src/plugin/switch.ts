/**
 * 版本切换插件 (teleproto/gramjs)
 *
 * 命令：
 *   .switch go       — 转换 session 并切换到另一个版本（无需重新登录）
 *   .switch status   — 查看状态
 *   .switch revert   — 回到上一个版本
 *
 * Session 通过 @mtcute/convert 离线互转（teleproto StringSession ↔ mtcute SQLite），
 * 不再走 .switch login / code / pwd 重新登录。
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
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const EMOJI: Record<string, string> = {
  teleproto: "🟦",
  mtcute: "🟧",
};

const T = {
  help: () =>
    [
      `**🔄 版本切换**\n`,
      `在 **teleproto** 和 **mtcute** 之间切换。`,
      `会把当前账号的 session **直接转换**过去，**不用重新登录 / 收验证码**。\n`,
      `**命令：**`,
      `\`${mainPrefix}switch go\` — 🚀 转换 session 并切换到另一个版本`,
      `\`${mainPrefix}switch status\` — 📊 查看当前状态`,
      `\`${mainPrefix}switch revert\` — ⏪ 回到上一个版本`,
    ].join("\n"),

  status: (state: ReturnType<typeof loadSwitchState>) => {
    const lines: string[] = [];
    const active = state.activeVersion;
    if (active) {
      lines.push(`**🟢 当前运行：${EMOJI[active]} ${label(active)}**`);
    } else {
      lines.push("**⚪ 尚未切换过**（当前进程是 teleproto）");
    }

    lines.push("");
    for (const v of ["teleproto", "mtcute"] as TeleBoxVersion[]) {
      const sess = state.sessions[v];
      const icon = active === v ? "🟢" : "⚪";
      let badge: string;
      let detail: string;
      if (sess.kind === "external") {
        badge = "🔑 已转换";
        detail = `(uid ${sess.userId})`;
      } else if (v === "teleproto" && hasTeleprotoNativeSession()) {
        badge = "📦 本地 session";
        detail = "config.json";
      } else if (v === "mtcute" && hasMtcuteNativeSession()) {
        badge = "📦 本地 session";
        detail = "session.db";
      } else {
        badge = "⚡ 切换时自动转换";
        detail = "从当前版本导出";
      }
      lines.push(`${icon} ${EMOJI[v]} **${label(v)}** — ${badge} ${detail}`);
    }

    return lines.join("\n");
  },

  goSwitching: (target: TeleBoxVersion) =>
    [
      `🚀 **开始切换！** → ${EMOJI[target]} ${label(target)}`,
      ``,
      `正在把当前 session 转换成目标格式（不重新登录）…`,
      `bot 会短暂离线几秒。`,
    ].join("\n"),

  goNoSourceSession: () =>
    [
      `❌ 当前 teleproto 没有可用的 session（config.json.session 为空）`,
      ``,
      `请先正常登录 teleproto，再执行 \`${mainPrefix}switch go\`。`,
    ].join("\n"),

  revertNoNeed: () => "ℹ️ 已经在上一个版本了，不需要撤回～",

  revertStarted: () => "⏪ 正在撤回… 稍等一下哦",

  unknownSub: (sub: string) =>
    `🤔 \`${sub}\` 是啥？没这个命令…\n\n` + T.help(),
};

function label(v: TeleBoxVersion): string {
  return v === "teleproto" ? "teleproto (gramjs)" : "mtcute (native)";
}

function detectCurrentVersion(): TeleBoxVersion {
  return "teleproto";
}

function hasTeleprotoNativeSession(): boolean {
  try {
    const config = JSON.parse(
      fs.readFileSync("/root/telebox/config.json", "utf8"),
    ) as { session?: string };
    return Boolean(config.session && String(config.session).trim().length > 10);
  } catch {
    return false;
  }
}

function hasMtcuteNativeSession(): boolean {
  return fs.existsSync("/root/telebox_mtcute/session.db");
}

function spawnController(
  source: TeleBoxVersion,
  target: TeleBoxVersion,
  forceConvert: boolean,
): void {
  // Always run controller from target repo (same as before)
  const repoRoot = target === "mtcute" ? "/root/telebox_mtcute" : "/root/telebox";
  const child = spawn(
    "npx",
    ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchController.ts")],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        // skipLogin=1 means "don't wait for pendingLogin"; convert still runs when needed
        SWITCH_SKIP_LOGIN: forceConvert ? "0" : "1",
        SWITCH_SOURCE: source,
        SWITCH_TARGET: target,
      },
    },
  );
  child.unref();
}

const plugin = new (class extends Plugin {
  name = "switch";
  description = "版本切换 (teleproto ↔ mtcute，session 直转)";

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
      // Legacy commands: point users to the new flow
      if (sub === "login" || sub === "code" || sub === "pwd" || sub === "password") {
        await msg.edit({
          text: [
            `ℹ️ 已改为 **session 直接转换**，不再需要重新登录。`,
            ``,
            `直接发 \`${mainPrefix}switch go\` 即可。`,
          ].join("\n"),
        });
        return;
      }
      if (sub === "go") {
        await this.handleGo(msg);
        return;
      }
      if (sub === "revert") {
        await this.handleRevert(msg);
        return;
      }
      await msg.edit({ text: T.unknownSub(sub) });
    },
  };

  private async handleGo(msg: Api.Message): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (current === "teleproto" && !hasTeleprotoNativeSession()) {
      await msg.edit({ text: T.goNoSourceSession() });
      return;
    }

    await msg.edit({ text: T.goSwitching(target) });
    state.pendingNotification = {
      chatId: Number(msg.chatId),
      msgId: msg.id,
      target,
    };
    // Clear any stale pending login from old flow
    state.pendingLogin = null;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    // Force convert unless target already has a registered external session file
    const targetSess = state.sessions[target];
    const hasExternal =
      targetSess.kind === "external" &&
      typeof targetSess.path === "string" &&
      fs.existsSync(targetSess.path);
    // Always convert from current live session so switch picks up latest auth keys
    const forceConvert = true;
    void hasExternal; // reserved for future cache optimization

    spawnController(current, target, forceConvert);
  }

  private async handleRevert(msg: Api.Message): Promise<void> {
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const current = detectCurrentVersion();

    if (!state.activeVersion || state.activeVersion === current) {
      await msg.edit({ text: T.revertNoNeed() });
      return;
    }

    await msg.edit({ text: T.revertStarted() });

    const revertTarget: TeleBoxVersion =
      state.activeVersion === "teleproto" ? "mtcute" : "teleproto";
    state.pendingNotification = {
      chatId: Number(msg.chatId),
      msgId: msg.id,
      target: revertTarget,
    };
    state.pendingLogin = null;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    // Revert also re-converts from current → previous to keep sessions fresh
    spawnController(current, revertTarget, true);
  }
})();

export default plugin;
