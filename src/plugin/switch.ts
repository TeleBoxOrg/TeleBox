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
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const EMOJI: Record<string, string> = {
  teleproto: "🟦",
  mtcute: "🟧",
};

function label(v: TeleBoxVersion): string {
  return v === "teleproto" ? "teleproto" : "mtcute";
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

const T = {
  help: () =>
    [
      `**🔄 版本切换**`,
      ``,
      `在 teleproto 和 mtcute 之间切换。`,
      `账号 session 直接转换，**不用重新登录**。`,
      ``,
      `**命令**`,
      `\`${mainPrefix}switch go\` — 切到另一个版本`,
      `\`${mainPrefix}switch status\` — 查看当前状态`,
      ``,
      `**切换时会做这些事**`,
      `• 转换账号 session`,
      `• 同步两边都有的插件，并合并配置`,
      `• 另一边没有的插件 → 保存到本机归档，不会丢`,
    ].join("\n"),

  status: (state: ReturnType<typeof loadSwitchState>) => {
    const current = detectCurrentVersion();
    const other: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const lines = [
      `**当前：${EMOJI[current]} ${label(current)}**`,
      `**另一边：${EMOJI[other]} ${label(other)}**`,
      ``,
      `发 \`${mainPrefix}switch go\` 即可切过去。`,
    ];
    if (state.activeVersion) {
      lines.push(``, `上次切换到：${EMOJI[state.activeVersion]} ${label(state.activeVersion)}`);
    }
    return lines.join("\n");
  },

  goSwitching: (target: TeleBoxVersion) =>
    [
      `🚀 **正在切换到 ${EMOJI[target]} ${label(target)}**`,
      ``,
      `• 转换 session（不重新登录）`,
      `• 同步插件与配置`,
      `• 另一边没有的插件会归档保存`,
      ``,
      `bot 会短暂离线几秒，完成后这条消息会更新。`,
    ].join("\n"),

  goNoSourceSession: () =>
    [
      `❌ 当前没有可用的 session`,
      ``,
      `请先正常登录 teleproto，再发 \`${mainPrefix}switch go\`。`,
    ].join("\n"),

  legacyRemoved: () =>
    [
      `ℹ️ 现在只需要：`,
      ``,
      `\`${mainPrefix}switch go\` — 直接切到另一个版本`,
      `\`${mainPrefix}switch status\` — 查看状态`,
      ``,
      `不用 login / code / pwd / revert。`,
    ].join("\n"),

  unknownSub: (sub: string) =>
    `不知道 \`${sub}\` 是什么命令。\n\n` + T.help(),
};

function spawnController(source: TeleBoxVersion, target: TeleBoxVersion): void {
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
        // Always convert from the live session on go
        SWITCH_SKIP_LOGIN: "0",
        SWITCH_SOURCE: source,
        SWITCH_TARGET: target,
      },
    },
  );
  child.unref();
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
    state.pendingNotification = {
      chatId: Number(msg.chatId),
      msgId: msg.id,
      target,
    };
    state.pendingLogin = null;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);
    spawnController(current, target);
  }
})();

export default plugin;
