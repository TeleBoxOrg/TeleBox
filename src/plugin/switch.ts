/**
 * Version switching plugin (teleproto/gramjs).
 *
 * Commands:
 *   .switch login [phone]    — 发起登录（spawn 轮询 helper → auth.sendCode → 等码）
 *   .switch code <code>      — 手动输入验证码（helper 轮询消耗）
 *   .switch pwd <password>   — 手动输入 2FA 密码（helper 轮询消耗）
 *   .switch status           — 查看切换状态
 *   .switch go               — 执行 PM2 切换（session 必须已就绪）
 *   .switch revert           — 回滚到原版本
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

const VERSION_NAMES: Record<TeleBoxVersion, string> = {
  teleproto: "teleproto (gramjs)",
  mtcute: "mtcute (native)",
};

function detectCurrentVersion(): TeleBoxVersion {
  return "teleproto";
}

function formatStatus(state: ReturnType<typeof loadSwitchState>): string {
  const lines: string[] = ["**📊 版本切换状态**\n"];
  const active = state.activeVersion || "none";
  lines.push(`**活跃版本**：${active}`);
  for (const ver of ["teleproto", "mtcute"] as TeleBoxVersion[]) {
    const session = state.sessions[ver];
    const marker = active === ver ? " ✅ (当前)" : "";
    lines.push(
      session.kind === "native"
        ? `- ${VERSION_NAMES[ver]}：原生 session${marker}`
        : `- ${VERSION_NAMES[ver]}：外部 session (user ${session.userId})${marker}`,
    );
  }
  if (state.pendingLogin) {
    const pl = state.pendingLogin;
    const remaining = Math.max(0, Math.ceil((pl.expiresAt - Date.now()) / 1000));
    lines.push(`\n**⏳ 登录进行中**：${VERSION_NAMES[pl.target]}`);
    lines.push(`- 手机号：\`${pl.phone}\``);
    lines.push(`- 剩余时间：${remaining}s`);
  }
  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "**🔄 版本切换**\n",
    "`" + mainPrefix + "switch login [phone]` — 开始登录（自动请求验证码并等待）",
    "`" + mainPrefix + "switch code <验证码>` — 手动输入验证码",
    "`" + mainPrefix + "switch pwd <2FA密码>` — 手动输入 2FA 密码",
    "`" + mainPrefix + "switch status` — 查看当前状态",
    "`" + mainPrefix + "switch go` — 执行切换（需登录已完成）",
    "`" + mainPrefix + "switch revert` — 回滚到原版本",
    "",
    "*验证码会自动从 Telegram 官方消息 (777000) 中提取*",
  ].join("\n");
}

const plugin = new (class extends Plugin {
  name = "switch";
  description = "版本切换 (teleproto ↔ mtcute)";

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    switch: async (msg) => {
      const text = msg.message || "";
      const parts = text.split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();

      if (!sub || sub === "help") { await msg.edit({ text: formatHelp() }); return; }
      if (sub === "status") { await msg.edit({ text: formatStatus(loadSwitchState(DEFAULT_SWITCH_HOME)) }); return; }
      if (sub === "login") { await this.handleLogin(msg, parts.slice(2)); return; }
      if (sub === "code") { await this.handleCode(msg, parts.slice(2)); return; }
      if (sub === "pwd" || sub === "password") { await this.handlePassword(msg, parts.slice(2)); return; }
      if (sub === "go") { await this.handleGo(msg); return; }
      if (sub === "revert") { await this.handleRevert(msg); return; }
      await msg.edit({ text: `未知子命令: \`${sub}\`\n\n` + formatHelp() });
    },
  };

  // ── listenMessageHandler: auto-capture Telegram login codes ──────────
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
        await msg.reply({ message: `✅ 验证码已捕获，登录 helper 将自动消耗` });
      }
      return;
    }

    // From bot owner — check for manual code in short messages
    if (senderId === "7041948142") {
      const codeMatch = text.match(/\b(\d{5,6})\b/);
      if (codeMatch && text.length < 15) {
        writeSecret(codeMatch[1], 5 * 60_000, DEFAULT_SWITCH_HOME);
      }
    }
  };

  // ── Command handlers ─────────────────────────────────────────────────

  private async handleLogin(msg: Api.Message, args: string[]): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    // If target already has an external session, no need to re-login
    if (state.sessions[target].kind === "external") {
      await msg.edit({ text: `✅ ${VERSION_NAMES[target]} 已有 session，直接 \`${mainPrefix}switch go\` 即可` });
      return;
    }

    // If already logging in, report status
    if (state.pendingLogin && state.pendingLogin.expiresAt > Date.now()) {
      await msg.edit({
        text: `⏳ 登录已在运行中 (${VERSION_NAMES[state.pendingLogin.target]})\n等待验证码... 或手动输入 \`${mainPrefix}switch code <码>\``,
      });
      return;
    }

    const expectedUserId = String(msg.senderId ?? msg.sender?.id ?? "");
    const phone = args[0] || "+86";

    const pending: PendingLogin = {
      target,
      expectedUserId,
      phone: phone.startsWith("+") ? phone : `+${phone}`,
      expiresAt: Date.now() + 5 * 60_000,
    };

    state.pendingLogin = pending;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    // Spawn the login helper IMMEDIATELY — it will connect, call auth.sendCode,
    // and poll secrets/ until the code/password arrive.
    const repoRoot = target === "mtcute" ? "/root/telebox_mtcute" : "/root/telebox";
    const child = spawn(
      "npx", ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchLogin.ts")],
      { cwd: repoRoot, detached: true, stdio: "ignore" },
    );
    child.unref();

    await msg.edit({
      text: [
        `**⏳ 开始登录到 ${VERSION_NAMES[target]}**`,
        "",
        `手机号：\`${pending.phone}\``,
        "",
        "📱 登录 helper 已启动 → 正在请求 Telegram 发送验证码...",
        "验证码到达后自动捕获并完成登录。",
        `手动输入：\`${mainPrefix}switch code <验证码>\``,
        `如有 2FA：\`${mainPrefix}switch pwd <密码>\``,
        "",
        `登录完成后使用 \`${mainPrefix}switch go\` 执行切换`,
      ].join("\n"),
    });
  }

  private async handleCode(msg: Api.Message, args: string[]): Promise<void> {
    const code = args[0]?.trim();
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: "❌ 没有正在进行的登录（可能已过期），请先 `.switch login`" });
      return;
    }
    if (!code || !/^\d{5,6}$/.test(code)) {
      await msg.edit({ text: "❌ 验证码格式错误（应为 5-6 位数字）" });
      return;
    }
    writeSecret(code, 5 * 60_000, DEFAULT_SWITCH_HOME);
    await msg.edit({ text: "✅ 验证码已写入，helper 将自动消耗" });
  }

  private async handlePassword(msg: Api.Message, args: string[]): Promise<void> {
    const password = args.join(" ").trim();
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: "❌ 没有正在进行的登录（可能已过期）" });
      return;
    }
    if (!password) {
      await msg.edit({ text: "❌ 密码不能为空" });
      return;
    }
    writeSecret(password, 5 * 60_000, DEFAULT_SWITCH_HOME);
    await msg.edit({ text: "✅ 2FA 密码已写入，helper 将自动消耗" });
  }

  private async handleGo(msg: Api.Message): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const repoRoot = target === "mtcute" ? "/root/telebox_mtcute" : "/root/telebox";

    // Must have an external session ready
    if (state.sessions[target].kind !== "external") {
      await msg.edit({
        text: [
          `❌ ${VERSION_NAMES[target]} 还没有 session`,
          "",
          `请先执行 \`${mainPrefix}switch login\` 完成登录`,
          `（登录完成后 helper 会自动注册 session，然后才能 go）`,
        ].join("\n"),
      });
      return;
    }

    await msg.edit({ text: "🔄 目标版本 session 已就绪，正在切换..." });

    const child = spawn(
      "npx", ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchController.ts")],
      { cwd: repoRoot, detached: true, stdio: "ignore",
        env: { ...process.env, SWITCH_SKIP_LOGIN: "1", SWITCH_SOURCE: current, SWITCH_TARGET: target } },
    );
    child.unref();

    await msg.reply({
      message: [
        "✅ 切换控制器已启动（后台运行）",
        `目标版本：${VERSION_NAMES[target]}`,
        "",
        "1. 安装匹配插件",
        "2. 迁移插件配置/数据",
        "3. 停止当前版本 PM2",
        "4. 启动目标版本 PM2",
        "",
        "⚠️ 切换期间 bot 将短暂不可用",
      ].join("\n"),
    });
  }

  private async handleRevert(msg: Api.Message): Promise<void> {
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const current = detectCurrentVersion();
    if (!state.activeVersion || state.activeVersion === current) {
      await msg.edit({ text: "ℹ️ 当前已在原版本运行，无需回滚" });
      return;
    }
    await msg.edit({ text: "🔄 正在回滚..." });
    const target: TeleBoxVersion = state.activeVersion;
    const child = spawn(
      "npx", ["tsx", "/root/telebox/src/utils/versionSwitchController.ts"],
      { cwd: "/root/telebox", detached: true, stdio: "ignore",
        env: { ...process.env, SWITCH_REVERT: "1", SWITCH_REVERT_TARGET: target, SWITCH_REVERT_SOURCE: current } },
    );
    child.unref();
    await msg.reply({ message: "✅ 回滚已启动，原版本将恢复运行" });
  }
})();

export default plugin;
