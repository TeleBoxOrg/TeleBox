/**
 * 版本切换插件 (teleproto/gramjs)
 *
 * 命令：
 *   .switch login [手机号]   — 登录到另一个版本
 *   .switch code <验证码>    — 手动输入验证码
 *   .switch pwd <2FA密码>    — 手动输入两步验证密码
 *   .switch status           — 查看状态
 *   .switch go               — 开始切换
 *   .switch revert           — 回到上一个版本
 */
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import {
  loadSwitchState,
  saveSwitchState,
  writeSecret,
  DEFAULT_SWITCH_HOME,
} from "@utils/versionSwitchState";
import type { TeleBoxVersion, PendingLogin } from "@utils/versionSwitchState";
import { extractTelegramLoginCode } from "@utils/versionSwitchCore";
import { spawn } from "child_process";
import path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const TELEGRAM_SERVICE_USER = "777000";

const EMOJI: Record<string, string> = {
  teleproto: "🟦",
  mtcute: "🟧",
};

// ── 文案（小白友好）────────────────────────────────────────────────

const T = {
  help: () =>
    [
      `**🔄 版本切换**\n`,
      `这个功能让你在**两个版本**之间自由切换，不用重新登录哦～\n`,
      `**常用命令：**`,
      `\`${mainPrefix}switch login\` — 🔑 登录到另一个版本（首次需要）`,
      `\`${mainPrefix}switch go\` — 🚀 开始切换`,
      `\`${mainPrefix}switch status\` — 📊 看看当前状态`,
      `\`${mainPrefix}switch revert\` — ⏪ 撤回，回到上一个版本`,
      `\n**备用命令（验证码收不到时手动输入）：**`,
      `\`${mainPrefix}switch code <6位数字>\` — 📱 手动输入验证码`,
      `\`${mainPrefix}switch pwd <密码>\` — 🔐 手动输入两步验证密码`,
    ].join("\n"),

  status: (state: ReturnType<typeof loadSwitchState>) => {
    const lines: string[] = [];
    const active = state.activeVersion;
    if (active) {
      lines.push(`**🟢 当前运行：${EMOJI[active]} ${label(active)}**`);
    } else {
      lines.push("**⚪ 尚未切换过**");
    }

    lines.push("");
    for (const v of ["teleproto", "mtcute"] as TeleBoxVersion[]) {
      const sess = state.sessions[v];
      const icon = active === v ? "🟢" : "⚪";
      const badge = sess.kind === "external" ? "🔑 已登录" : "❓ 未登录";
      const detail = sess.kind === "external" ? `\\(uid ${sess.userId}\\)` : "需要先登录";
      lines.push(`${icon} ${EMOJI[v]} **${label(v)}** — ${badge} ${detail}`);
    }

    if (state.pendingLogin) {
      const pl = state.pendingLogin;
      const sec = Math.max(0, Math.ceil((pl.expiresAt - Date.now()) / 1000));
      lines.push(`\n⏳ **正在登录** ${EMOJI[pl.target]} ${label(pl.target)}`);
      lines.push(`　手机号 \`${pl.phone}\` · 还剩 ${sec} 秒`);
    }

    return lines.join("\n");
  },

  loginStarted: (target: TeleBoxVersion, phone: string) =>
    [
      `**🔑 正在登录到 ${EMOJI[target]} ${label(target)}**\n`,
      `📱 已向 Telegram 请求验证码 → 请留意手机 / 已登录设备`,
      `　手机号：\`${phone}\``,
      ``,
      `收到验证码后，机器人会自动抓取并完成登录 ✨`,
      ``,
      `如果过了好久都没收到：`,
      `• 手动输入：\`${mainPrefix}switch code <验证码>\``,
      `• 有开启两步验证的话，还要：\`${mainPrefix}switch pwd <密码>\``,
      ``,
      `登录完成后，发 \`${mainPrefix}switch go\` 就能切过去啦！`,
    ].join("\n"),

  loginAlready: (target: TeleBoxVersion) =>
    `✅ ${EMOJI[target]} ${label(target)} 已经登录过了！\n直接 \`${mainPrefix}switch go\` 就能切过去～`,

  loginRunning: (target: TeleBoxVersion) =>
    `⏳ 已经在登录 ${EMOJI[target]} ${label(target)} 了…\n等验证码中，手动输入的话：\`${mainPrefix}switch code <码>\``,

  codeCaptured: () => "✅ 验证码已捕获！机器人会自动帮你完成登录～",

  codeWritten: () => "✅ 收到了！验证码已存入，机器人会自动完成登录 ✨",

  pwdWritten: () => "✅ 收到了！密码已存入，机器人会自动完成登录 ✨",

  noPendingLogin: () =>
    `❌ 当前没有正在进行的登录哦\n先发 \`${mainPrefix}switch login\` 开始登录吧～`,

  codeBadFormat: () => "❌ 验证码一般是 **5～6 位数字**，检查一下？",

  pwdEmpty: () => "❌ 密码不能为空哦",

  goNotReady: (target: TeleBoxVersion) =>
    [
      `❌ ${EMOJI[target]} ${label(target)} **还没登录**`,
      ``,
      `先发 \`${mainPrefix}switch login\` 登录，等收到验证码完成登录后，`,
      `再用 \`${mainPrefix}switch go\` 切过去～`,
    ].join("\n"),

  goSwitching: (target: TeleBoxVersion) =>
    `🚀 **开始切换！** → ${EMOJI[target]} ${label(target)}\n\n正在后台处理中，bot 会短暂离线几秒…`,

  goDone: (target: TeleBoxVersion) =>
    [
      `🎉 **切换完成！** 现在运行的是 ${EMOJI[target]} ${label(target)}`,
      ``,
      `想切回去？发 \`${mainPrefix}switch revert\` 就行。`,
    ].join("\n"),

  revertNoNeed: () => "ℹ️ 已经在上一个版本了，不需要撤回～",

  revertStarted: () => "⏪ 正在撤回… 稍等一下哦",

  revertDone: () => "✅ 已回到上一个版本！",

  unknownSub: (sub: string) =>
    `🤔 \`${sub}\` 是啥？没这个命令…\n\n` + T.help(),
};

function label(v: TeleBoxVersion): string {
  return v === "teleproto" ? "teleproto (gramjs)" : "mtcute (native)";
}

function detectCurrentVersion(): TeleBoxVersion {
  return "teleproto";
}

// ── 插件 ─────────────────────────────────────────────────────────────

const plugin = new (class extends Plugin {
  name = "switch";
  description = "版本切换 (teleproto ↔ mtcute)";

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    switch: async (msg) => {
      const text = msg.message || "";
      const parts = text.split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();

      if (!sub || sub === "help") { await msg.edit({ text: T.help() }); return; }
      if (sub === "status") { await msg.edit({ text: T.status(loadSwitchState(DEFAULT_SWITCH_HOME)) }); return; }
      if (sub === "login") { await this.handleLogin(msg, parts.slice(2)); return; }
      if (sub === "code") { await this.handleCode(msg, parts.slice(2)); return; }
      if (sub === "pwd" || sub === "password") { await this.handlePassword(msg, parts.slice(2)); return; }
      if (sub === "go") { await this.handleGo(msg); return; }
      if (sub === "revert") { await this.handleRevert(msg); return; }
      await msg.edit({ text: T.unknownSub(sub) });
    },
  };

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    const senderId = String(msg.senderId ?? msg.sender?.id ?? "");
    const text = msg.message || "";
    if (senderId !== TELEGRAM_SERVICE_USER && senderId !== "7041948142") return;

    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) return;

    if (senderId === TELEGRAM_SERVICE_USER) {
      const code = extractTelegramLoginCode(text);
      if (code) {
        writeSecret(code, 5 * 60_000, DEFAULT_SWITCH_HOME);
        await msg.reply({ message: T.codeCaptured() });
      }
      return;
    }

    if (senderId === "7041948142") {
      const codeMatch = text.match(/\b(\d{5,6})\b/);
      if (codeMatch && text.length < 15) {
        writeSecret(codeMatch[1], 5 * 60_000, DEFAULT_SWITCH_HOME);
      }
    }
  };

  // ── 命令处理 ──────────────────────────────────────────────────────

  private async handleLogin(msg: Api.Message, args: string[]): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (state.sessions[target].kind === "external") {
      await msg.edit({ text: T.loginAlready(target) });
      return;
    }

    if (state.pendingLogin && state.pendingLogin.expiresAt > Date.now()) {
      await msg.edit({ text: T.loginRunning(state.pendingLogin.target) });
      return;
    }

    const phone = args[0] || "+86";
    const pending: PendingLogin = {
      target,
      expectedUserId: String(msg.senderId ?? msg.sender?.id ?? ""),
      phone: phone.startsWith("+") ? phone : `+${phone}`,
      expiresAt: Date.now() + 5 * 60_000,
    };

    state.pendingLogin = pending;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    const repoRoot = target === "mtcute" ? "/root/telebox_mtcute" : "/root/telebox";
    const child = spawn(
      "npx", ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchLogin.ts")],
      { cwd: repoRoot, detached: true, stdio: "ignore" },
    );
    child.unref();

    await msg.edit({ text: T.loginStarted(target, pending.phone) });
  }

  private async handleCode(msg: Api.Message, args: string[]): Promise<void> {
    const code = args[0]?.trim();
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: T.noPendingLogin() });
      return;
    }
    if (!code || !/^\d{5,6}$/.test(code)) {
      await msg.edit({ text: T.codeBadFormat() });
      return;
    }

    writeSecret(code, 5 * 60_000, DEFAULT_SWITCH_HOME);
    await msg.edit({ text: T.codeWritten() });
  }

  private async handlePassword(msg: Api.Message, args: string[]): Promise<void> {
    const password = args.join(" ").trim();
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: T.noPendingLogin() });
      return;
    }
    if (!password) {
      await msg.edit({ text: T.pwdEmpty() });
      return;
    }

    writeSecret(password, 5 * 60_000, DEFAULT_SWITCH_HOME);
    await msg.edit({ text: T.pwdWritten() });
  }

  private async handleGo(msg: Api.Message): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const repoRoot = target === "mtcute" ? "/root/telebox_mtcute" : "/root/telebox";

    // 两种 session 都有效：native（一直在自己目录里）或 external（switch login 登录的）
    if (state.sessions[target].kind !== "external" && state.sessions[target].kind !== "native") {
      await msg.edit({ text: T.goNotReady(target) });
      return;
    }

    await msg.edit({ text: T.goSwitching(target) });
    // 记录消息 ID，等目标版本上线后用新客户端编辑状态
    state.pendingNotification = { chatId: Number(msg.chatId), msgId: msg.id, target };
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    const child = spawn(
      "npx", ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchController.ts")],
      { cwd: repoRoot, detached: true, stdio: "ignore",
        env: { ...process.env, SWITCH_SKIP_LOGIN: "1", SWITCH_SOURCE: current, SWITCH_TARGET: target } },
    );
    child.unref();
  }

  private async handleRevert(msg: Api.Message): Promise<void> {
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const current = detectCurrentVersion();

    if (!state.activeVersion || state.activeVersion === current) {
      await msg.edit({ text: T.revertNoNeed() });
      return;
    }

    await msg.edit({ text: T.revertStarted() });

    // revert 就是往另一个版本切，controller 需要标准的 source/target 参数
    const revertTarget: TeleBoxVersion = state.activeVersion === "teleproto" ? "mtcute" : "teleproto";
    state.pendingNotification = { chatId: Number(msg.chatId), msgId: msg.id, target: revertTarget };
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    const child = spawn(
      "npx", ["tsx", "/root/telebox/src/utils/versionSwitchController.ts"],
      { cwd: "/root/telebox", detached: true, stdio: "ignore",
        env: { ...process.env, SWITCH_SKIP_LOGIN: "1", SWITCH_SOURCE: current, SWITCH_TARGET: revertTarget } },
    );
    child.unref();
  }
})();

export default plugin;
