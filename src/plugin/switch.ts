/**
 * Version switching plugin (teleproto/gramjs).
 *
 * Commands:
 *   .switch login <version> [phone]  — 开始 pend 登录到目标版本
 *   .switch code <code>              — 手动输入验证码（备用）
 *   .switch pwd <password>           — 手动输入 2FA 密码（备用）
 *   .switch status                   — 查看切换状态
 *   .switch go                       — 执行切换
 *   .switch revert                   — 回滚到原版本
 *
 * Code capture: listenMessageHandler 监听来自 777000 的消息，
 * 自动提取验证码并写入 ~/.telebox-switch 临时文件（仅当有 pendingLogin 时）。
 * 2FA 密码通过 .switch pwd 命令或 listenMessageHandler 从用户私聊获取。
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
import fs from "fs";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const TELEGRAM_SERVICE_USER = "777000";

const VERSION_NAMES: Record<TeleBoxVersion, string> = {
  teleproto: "teleproto (gramjs)",
  mtcute: "mtcute (native)",
};

function detectCurrentVersion(): TeleBoxVersion {
  // teleproto 版运行此插件 → 当前是 teleproto
  return "teleproto";
}

function formatStatus(state: ReturnType<typeof loadSwitchState>): string {
  const lines: string[] = ["**📊 版本切换状态**\n"];

  const active = state.activeVersion || "none";
  lines.push(`**活跃版本**：${active}`);

  for (const ver of ["teleproto", "mtcute"] as TeleBoxVersion[]) {
    const session = state.sessions[ver];
    const marker = active === ver ? " ✅ (当前)" : "";
    if (session.kind === "native") {
      lines.push(`- ${VERSION_NAMES[ver]}：原生 session${marker}`);
    } else {
      lines.push(`- ${VERSION_NAMES[ver]}：外部 session (user ${session.userId})${marker}`);
    }
  }

  if (state.pendingLogin) {
    const pl = state.pendingLogin;
    const remaining = Math.max(0, Math.ceil((pl.expiresAt - Date.now()) / 1000));
    lines.push(`\n**⏳ 待处理登录**：${VERSION_NAMES[pl.target]}`);
    lines.push(`- 手机号：\`${pl.phone}\``);
    lines.push(`- 预期用户ID：\`${pl.expectedUserId}\``);
    lines.push(`- 剩余时间：${remaining}s`);
    if (state.stagedSecrets.code) lines.push("- 验证码：✅ 已暂存");
    else lines.push("- 验证码：⏳ 等待中（Telegram 会发送到已登录设备）");
    if (state.stagedSecrets.password) lines.push("- 2FA 密码：✅ 已暂存");
  }

  if (state.pendingTransaction) {
    lines.push(`\n**🔄 事务进行中**：\`${state.pendingTransaction}\``);
  }

  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "**🔄 版本切换**\n",
    "`" + mainPrefix + "switch login [phone]` — 开始登录到另一个版本",
    "`" + mainPrefix + "switch code <验证码>` — 手动输入验证码",
    "`" + mainPrefix + "switch pwd <2FA密码>` — 手动输入 2FA 密码",
    "`" + mainPrefix + "switch status` — 查看当前状态",
    "`" + mainPrefix + "switch go` — 执行切换",
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

      if (!sub || sub === "help") {
        await msg.edit({ text: formatHelp() });
        return;
      }

      if (sub === "status") {
        const state = loadSwitchState(DEFAULT_SWITCH_HOME);
        await msg.edit({ text: formatStatus(state) });
        return;
      }

      if (sub === "login") {
        await this.handleLogin(msg, parts.slice(2));
        return;
      }

      if (sub === "code") {
        await this.handleCode(msg, parts.slice(2));
        return;
      }

      if (sub === "pwd" || sub === "password") {
        await this.handlePassword(msg, parts.slice(2));
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

      await msg.edit({ text: `未知子命令: \`${sub}\`\n\n` + formatHelp() });
    },
  };

  // ── listenMessageHandler: auto-capture Telegram login codes ──────────
  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    const senderId = String(msg.senderId ?? msg.sender?.id ?? "");
    const text = msg.message || "";

    // Only capture from Telegram service (777000) or from the bot owner
    if (senderId !== TELEGRAM_SERVICE_USER && senderId !== "7041948142") {
      return;
    }

    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      return; // No active pending login
    }

    if (senderId === TELEGRAM_SERVICE_USER) {
      // Telegram official login code message
      const code = extractTelegramLoginCode(text);
      if (code && !state.stagedSecrets.code) {
        const secretPath = writeSecret(code, 5 * 60_000, DEFAULT_SWITCH_HOME);
        state.stagedSecrets.code = secretPath;
        saveSwitchState(state, DEFAULT_SWITCH_HOME);
        await msg.reply({
          message: `✅ 验证码已捕获 (\`${code}\`)，使用 \`${mainPrefix}switch go\` 执行切换`,
        });
      }
      return;
    }

    // From bot owner — check for manual code/password
    if (senderId === "7041948142") {
      const codeMatch = text.match(/\b(\d{5,6})\b/);
      if (codeMatch && !state.stagedSecrets.code && text.length < 15) {
        const code = codeMatch[1];
        const secretPath = writeSecret(code, 5 * 60_000, DEFAULT_SWITCH_HOME);
        state.stagedSecrets.code = secretPath;
        saveSwitchState(state, DEFAULT_SWITCH_HOME);
      }
    }
  };

  // ── Command handlers ─────────────────────────────────────────────────

  private async handleLogin(msg: Api.Message, args: string[]): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";

    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    // Get expected user ID from current session
    const expectedUserId = String(msg.senderId ?? msg.sender?.id ?? "");

    // Phone: from args[1], or use default
    const phone = args[1] || "+86";

    const pending: PendingLogin = {
      target,
      expectedUserId,
      phone: phone.startsWith("+") ? phone : `+${phone}`,
      expiresAt: Date.now() + 5 * 60_000, // 5 minutes
    };

    state.pendingLogin = pending;
    state.stagedSecrets = {};
    state.pendingTransaction = `login-${Date.now()}`;
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    await msg.edit({
      text: [
        `**⏳ 开始登录到 ${VERSION_NAMES[target]}**`,
        "",
        `手机号：\`${pending.phone}\``,
        `预期用户ID：\`${expectedUserId}\``,
        "",
        "📱 Telegram 验证码将自动捕获（来自 777000），",
        `或手动输入：\`${mainPrefix}switch code <验证码>\``,
        `如需 2FA：\`${mainPrefix}switch pwd <密码>\``,
        "",
        `准备就绪后使用 \`${mainPrefix}switch go\` 执行切换`,
        "",
      ].join("\n"),
    });
  }

  private async handleCode(msg: Api.Message, args: string[]): Promise<void> {
    const code = args[0]?.trim();
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: "❌ 没有待处理的登录（可能已过期），请先执行 `.switch login`" });
      return;
    }

    if (!code || !/^\d{5,6}$/.test(code)) {
      await msg.edit({ text: "❌ 验证码格式错误（应为 5-6 位数字）" });
      return;
    }

    const secretPath = writeSecret(code, 5 * 60_000, DEFAULT_SWITCH_HOME);
    state.stagedSecrets.code = secretPath;
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    await msg.edit({ text: `✅ 验证码已暂存，使用 \`${mainPrefix}switch go\` 执行切换` });
  }

  private async handlePassword(msg: Api.Message, args: string[]): Promise<void> {
    const password = args.join(" ").trim();
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);

    if (!state.pendingLogin || state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: "❌ 没有待处理的登录（可能已过期）" });
      return;
    }

    if (!password) {
      await msg.edit({ text: "❌ 密码不能为空" });
      return;
    }

    const secretPath = writeSecret(password, 5 * 60_000, DEFAULT_SWITCH_HOME);
    state.stagedSecrets.password = secretPath;
    saveSwitchState(state, DEFAULT_SWITCH_HOME);

    await msg.edit({ text: `✅ 2FA 密码已暂存，使用 \`${mainPrefix}switch go\` 执行切换` });
  }

  private async handleGo(msg: Api.Message): Promise<void> {
    const current = detectCurrentVersion();
    const target: TeleBoxVersion = current === "teleproto" ? "mtcute" : "teleproto";
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const repoRoot = target === "mtcute" ? "/root/telebox_mtcute" : "/root/telebox";

    // Fast path: target already has a prepared external session → skip login
    const extSession = state.sessions[target];
    if (extSession.kind === "external") {
      state.pendingTransaction = `skip-login-${Date.now()}`;
      saveSwitchState(state, DEFAULT_SWITCH_HOME);

      await msg.edit({ text: "🔄 目标版本已有 session，直接切换..." });

      const child = spawn(
        "npx", ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchController.ts")],
        { cwd: repoRoot, detached: true, stdio: "ignore",
          env: { ...process.env, SWITCH_SKIP_LOGIN: "1", SWITCH_SOURCE: current, SWITCH_TARGET: target } },
      );
      child.unref();
      await msg.reply({
        message: [
          "✅ 切换控制器已启动（后台运行）",
          `目标版本：${VERSION_NAMES[target]}（已有 session，跳过登录）`,
          "",
          "切换过程：",
          "1. 安装匹配插件",
          "2. 迁移插件配置/数据",
          "3. 停止当前版本 PM2",
          "4. 启动目标版本 PM2",
          "",
          "⚠️ 切换期间 bot 将短暂不可用",
        ].join("\n"),
      });
      return;
    }

    // Slow path: no external session yet → need pendingLogin
    if (!state.pendingLogin) {
      await msg.edit({ text: `❌ 目标版本未有 session，请先执行 \`${mainPrefix}switch login\`` });
      return;
    }

    if (state.pendingLogin.expiresAt < Date.now()) {
      await msg.edit({ text: `❌ 登录已过期，请重新执行 \`${mainPrefix}switch login\`` });
      return;
    }

    if (!state.stagedSecrets.code) {
      await msg.edit({
        text:
          "❌ 尚未获取验证码\n" +
          "验证码会自动从 Telegram 官方消息 (777000) 中提取\n" +
          `或手动输入：\`${mainPrefix}switch code <验证码>\``,
      });
      return;
    }

    await msg.edit({ text: "🔄 正在启动切换控制器（后台独立进程）..." });

    const child = spawn(
      "npx", ["tsx", path.join(repoRoot, "src", "utils", "versionSwitchController.ts")],
      { cwd: repoRoot, detached: true, stdio: "ignore",
        env: { ...process.env, SWITCH_SOURCE: current, SWITCH_TARGET: target } },
    );
    child.unref();

    await msg.reply({
      message: [
        "✅ 切换控制器已启动（后台运行）",
        `目标版本：${VERSION_NAMES[target]}（首次登录）`,
        "",
        "切换过程：",
        "1. 登录到目标版本",
        "2. 安装匹配插件",
        "3. 迁移插件配置/数据",
        "4. 停止当前版本 PM2",
        "5. 启动目标版本 PM2",
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

    // To revert: stop current, restore original, restart source
    await msg.edit({ text: "🔄 正在回滚..." });

    const target: TeleBoxVersion = state.activeVersion;
    const source: TeleBoxVersion = current;

    const child = spawn(
      "npx",
      ["tsx", path.join(
        source === "teleproto" ? "/root/telebox" : "/root/telebox_mtcute",
        "src", "utils", "versionSwitchController.ts",
      )],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          SWITCH_REVERT: "1",
          SWITCH_REVERT_TARGET: target,
          SWITCH_REVERT_SOURCE: source,
        },
      },
    );

    child.unref();
    await msg.reply({ message: "✅ 回滚已启动，原版本将恢复运行" });
  }
})();

export default plugin;
