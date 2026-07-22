/**
 * TeleBox Panel — system plugin (local-only, git-excluded).
 *
 * Commands:
 *   .panel              状态 / 帮助
 *   .panel on|off       开关
 *   .panel set <token>  设置 Bot Token
 *   .panel url <https>  设置 WebApp 公网地址
 *   .panel port <n>     设置本地端口
 *   .panel bind <host>  设置监听地址
 *   .panel admin add|del|list [userid]
 *   .panel open         发送小程序入口（需已配置 url）
 */

import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { htmlEscape } from "@utils/htmlEscape";
import { logger } from "@utils/logger";
import { Api } from "teleproto";
import {
  readPanelConfig,
  setPanelEnabled,
  setPanelBotToken,
  updatePanelConfig,
  addPanelAdmin,
  removePanelAdmin,
  listPanelAdmins,
  maskToken,
} from "@utils/panel/configStore";
import {
  applyPanelRuntimeFromConfig,
  shutdownPanelRuntime,
  ensurePanelProviders,
} from "@utils/panel/controller";
import { getOwnerId } from "@utils/panel/owner";
import { isBotRunning } from "@utils/panel/botService";
import { isHttpRunning, getHttpMeta } from "@utils/panel/httpServer";
import { startTunnel, stopTunnel, getTunnelUrl, isTunnelRunning } from "@utils/panel/cloudflareTunnel";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const HELP = `<b>🎛️ TeleBox Panel</b>
原生 Bot 小程序管理面板（本地模块，不进远端仓库）

<b>开关</b>
• <code>${mainPrefix}panel on</code> / <code>off</code>
• <code>${mainPrefix}panel status</code>

<blockquote expandable><b>Bot / 网络</b>
• <code>${mainPrefix}panel set <bot_token></code>
• <code>${mainPrefix}panel url https://你的域名</code>  (手动模式)
• <code>${mainPrefix}panel tunnel cloudflare|manual|off</code>  (隧道模式)
• <code>${mainPrefix}panel port 8787</code>
• <code>${mainPrefix}panel bind 0.0.0.0</code>
• <code>${mainPrefix}panel name 显示名</code></blockquote>

<blockquote expandable><b>管理员</b>
• <code>${mainPrefix}panel admin add <userid></code>
• <code>${mainPrefix}panel admin del <userid></code>
• <code>${mainPrefix}panel admin list</code></blockquote>

<b>入口</b>
• <code>${mainPrefix}panel open</code> — 说明如何打开小程序

<blockquote expandable><b>说明</b>
1. 用 @BotFather 新建 Bot，拿到 token
2. <code>${mainPrefix}panel set <token></code>
3. <code>${mainPrefix}panel tunnel cloudflare</code> 自动起 Cloudflare Tunnel（无需域名）
   或 <code>${mainPrefix}panel tunnel manual</code> 手动配 url
4. <code>${mainPrefix}panel on</code>
5. 在管理 Bot 里点 /start → 打开小程序</blockquote>`;

async function statusText(): Promise<string> {
  const cfg = await readPanelConfig();
  const ownerId = await getOwnerId();
  const meta = getHttpMeta();
  const { isTunnelRunning, getTunnelUrl } = await import("@utils/panel/cloudflareTunnel");
  const tunnelRunning = isTunnelRunning();
  const tunnelUrl = getTunnelUrl();
  const lines = [
    `<b>🎛️ Panel 状态</b>`,
    `• 开关: ${cfg.enabled ? "✅ 开" : "❌ 关"}`,
    `• Bot: ${cfg.botToken ? maskToken(cfg.botToken) : "未设置"} ${isBotRunning() ? "(运行中)" : "(未运行)"}`,
    `• HTTP: ${isHttpRunning() ? `✅ ${meta?.host}:${meta?.port}` : "❌ 未运行"}`,
    `• Tunnel: ${cfg.tunnelMode === "cloudflare" ? (tunnelRunning ? `✅ ${tunnelUrl}` : "⏳ 启动中") : cfg.tunnelMode === "manual" ? "手动模式" : "关闭"}`,
    `• 公网: ${cfg.publicBaseUrl ? htmlEscape(cfg.publicBaseUrl) : "未设置"}`,
    `• 显示名: ${htmlEscape(cfg.displayName || "TeleBox Panel")}`,
    `• Owner: ${ownerId ?? "未知"}`,
    `• 额外管理员: ${cfg.admins.length} 人`,
  ];
  return lines.join("\n");
}

class PanelPlugin extends Plugin {
  name = "panel";
  description = HELP;
  ignoreEdited = true;

  async setup(): Promise<void> {
    try {
      ensurePanelProviders();
      const cfg = await readPanelConfig();
      if (cfg.enabled) {
        const result = await applyPanelRuntimeFromConfig();
        logger.info(
          `[panel] auto-start enabled http=${result.http} bot=${result.bot}`,
        );
        if (result.warnings.length) {
          logger.warn(`[panel] warnings: ${result.warnings.join(" | ")}`);
        }
      }
    } catch (e: unknown) {
      logger.error("[panel] setup failed", e);
    }
  }

  async cleanup(): Promise<void> {
    try {
      await shutdownPanelRuntime();
    } catch (e: unknown) {
      logger.warn("[panel] cleanup failed", e);
    }
  }

  cmdHandlers = {
    panel: async (msg: Api.Message) => {
      try {
        const parts = (msg.text || "").trim().split(/\s+/);
        const sub = (parts[1] || "").toLowerCase();
        const rest = parts.slice(2);

        if (!sub || sub === "help" || sub === "h") {
          await msg.edit({ text: HELP, parseMode: "html" });
          return;
        }

        if (sub === "status" || sub === "st") {
          await msg.edit({ text: await statusText(), parseMode: "html" });
          return;
        }

        if (sub === "on" || sub === "enable" || sub === "start") {
          await setPanelEnabled(true);
          const result = await applyPanelRuntimeFromConfig();
          const warn = result.warnings.length
            ? `\n\n⚠️ ${result.warnings.map(htmlEscape).join("\n⚠️ ")}`
            : "";
          await msg.edit({
            text:
              `✅ Panel 已开启\n• HTTP: ${result.http ? "✅" : "❌"} ${result.bind ? htmlEscape(result.bind) : ""}\n• Bot: ${result.bot ? "✅" : "❌"}${warn}`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "off" || sub === "disable" || sub === "stop") {
          await setPanelEnabled(false);
          await applyPanelRuntimeFromConfig();
          await msg.edit({ text: "✅ Panel 已关闭", parseMode: "html" });
          return;
        }

        if (sub === "set" || sub === "token") {
          const token = rest.join(" ").trim();
          if (!token || !token.includes(":")) {
            await msg.edit({
              text:
                `❌ 请提供 Bot Token\n<code>${mainPrefix}panel set 123456:AA...</code>`,
              parseMode: "html",
            });
            return;
          }
          await setPanelBotToken(token);
          const cfg = await readPanelConfig();
          if (cfg.enabled) await applyPanelRuntimeFromConfig();
          await msg.edit({
            text: `✅ 已设置 Bot Token: <code>${htmlEscape(maskToken(token))}</code>`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "url" || sub === "base") {
          const url = rest.join(" ").trim().replace(/\/+$/, "");
          if (!url) {
            await msg.edit({
              text:
                `❌ 请提供 HTTPS 公网地址\n<code>${mainPrefix}panel url https://panel.example.com</code>`,
              parseMode: "html",
            });
            return;
          }
          if (!/^https:\/\//i.test(url)) {
            await msg.edit({
              text: "❌ Telegram WebApp 要求 <b>https://</b> 公网地址",
              parseMode: "html",
            });
            return;
          }
          await updatePanelConfig({ publicBaseUrl: url });
          const cfg = await readPanelConfig();
          if (cfg.enabled) await applyPanelRuntimeFromConfig();
          await msg.edit({
            text: `✅ 公网地址: <code>${htmlEscape(url)}</code>`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "tunnel") {
          const action = (rest[0] || "").toLowerCase();
          if (action === "on" || action === "cloudflare" || action === "cf") {
            await updatePanelConfig({ tunnelMode: "cloudflare" });
            const cfg = await readPanelConfig();
            if (cfg.enabled) {
              // Trigger async tunnel start (don't await)
              applyPanelRuntimeFromConfig().catch((e) => {
                logger.error("[panel] async tunnel start failed", e);
              });
              await msg.edit({ text: "🔄 Tunnel 模式: <b>Cloudflare</b> — 后台启动中，请稍候...", parseMode: "html" });
            } else {
              await msg.edit({ text: "✅ Tunnel 模式: <b>Cloudflare</b>（面板开启时自动起隧道）", parseMode: "html" });
            }
            return;
          }
          if (action === "off") {
            await updatePanelConfig({ tunnelMode: "off" });
            const cfg = await readPanelConfig();
            if (cfg.enabled) {
              const result = await applyPanelRuntimeFromConfig();
              if (result.warnings.length) {
                await msg.edit({
                  text: `✅ Tunnel 模式: <b>关闭</b>\n⚠️ ${result.warnings.map(htmlEscape).join("\n⚠️ ")}`,
                  parseMode: "html",
                });
              } else {
                await msg.edit({ text: "✅ Tunnel 模式: <b>关闭</b>（使用手动 URL）", parseMode: "html" });
              }
            } else {
              await msg.edit({ text: "✅ Tunnel 模式: <b>关闭</b>（使用手动 URL）", parseMode: "html" });
            }
            return;
          }
          if (action === "manual") {
            await updatePanelConfig({ tunnelMode: "manual" });
            const cfg = await readPanelConfig();
            if (cfg.enabled) {
              const result = await applyPanelRuntimeFromConfig();
              if (result.warnings.length) {
                await msg.edit({
                  text: `✅ Tunnel 模式: <b>手动</b>\n⚠️ ${result.warnings.map(htmlEscape).join("\n⚠️ ")}`,
                  parseMode: "html",
                });
              } else {
                await msg.edit({ text: "✅ Tunnel 模式: <b>手动</b>（需自行配 .panel url）", parseMode: "html" });
              }
            } else {
              await msg.edit({ text: "✅ Tunnel 模式: <b>手动</b>（需自行配 .panel url）", parseMode: "html" });
            }
            return;
          }
          if (action === "status" || action === "st" || !action) {
            const cfg = await readPanelConfig();
            const { isTunnelRunning, getTunnelUrl } = await import("@utils/panel/cloudflareTunnel");
            const running = isTunnelRunning();
            const url = getTunnelUrl();
            await msg.edit({
              text:
                `🌐 Tunnel 状态\n` +
                `• 模式: <b>${cfg.tunnelMode}</b>\n` +
                `• 运行中: ${running ? "✅ 是" : "❌ 否"}\n` +
                `• 当前 URL: ${url ? `<code>${htmlEscape(url)}</code>` : "—"}`,
              parseMode: "html",
            });
            return;
          }
          await msg.edit({
            text:
              `用法:\n` +
              `<code>${mainPrefix}panel tunnel on</code> — 启用 Cloudflare 自动隧道\n` +
              `<code>${mainPrefix}panel tunnel off</code> — 关闭隧道\n` +
              `<code>${mainPrefix}panel tunnel manual</code> — 手动模式（自行配 URL）\n` +
              `<code>${mainPrefix}panel tunnel status</code> — 查看状态`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "port") {
          const port = Number(rest[0]);
          if (!Number.isFinite(port) || port < 1 || port > 65535) {
            await msg.edit({ text: "❌ 端口无效 (1-65535)", parseMode: "html" });
            return;
          }
          await updatePanelConfig({ bindPort: port });
          const cfg = await readPanelConfig();
          if (cfg.enabled) await applyPanelRuntimeFromConfig();
          await msg.edit({ text: `✅ 端口: <code>${port}</code>`, parseMode: "html" });
          return;
        }

        if (sub === "bind" || sub === "host") {
          const host = rest[0]?.trim();
          if (!host) {
            await msg.edit({ text: "❌ 请提供监听地址，如 0.0.0.0 或 127.0.0.1", parseMode: "html" });
            return;
          }
          await updatePanelConfig({ bindHost: host });
          const cfg = await readPanelConfig();
          if (cfg.enabled) await applyPanelRuntimeFromConfig();
          await msg.edit({ text: `✅ 监听: <code>${htmlEscape(host)}</code>`, parseMode: "html" });
          return;
        }

        if (sub === "name") {
          const name = rest.join(" ").trim();
          if (!name) {
            await msg.edit({ text: "❌ 请提供显示名", parseMode: "html" });
            return;
          }
          await updatePanelConfig({ displayName: name });
          await msg.edit({ text: `✅ 显示名: <b>${htmlEscape(name)}</b>`, parseMode: "html" });
          return;
        }

        if (sub === "admin" || sub === "admins") {
          const action = (rest[0] || "list").toLowerCase();
          if (action === "list" || action === "ls") {
            const admins = await listPanelAdmins();
            const ownerId = await getOwnerId();
            if (!admins.length) {
              await msg.edit({
                text:
                  `👥 Panel 管理员\n• Owner: <code>${ownerId ?? "未知"}</code>（始终允许）\n• 额外: 无`,
                parseMode: "html",
              });
              return;
            }
            const lines = admins.map(
              (a) =>
                `• <code>${a.userId}</code>${a.note ? ` — ${htmlEscape(a.note)}` : ""}`,
            );
            await msg.edit({
              text:
                `👥 Panel 管理员\n• Owner: <code>${ownerId ?? "未知"}</code>\n${lines.join("\n")}`,
              parseMode: "html",
            });
            return;
          }
          if (action === "add") {
            const uid = Number(rest[1]);
            const note = rest.slice(2).join(" ").trim() || undefined;
            if (!Number.isFinite(uid) || uid <= 0) {
              await msg.edit({
                text:
                  `❌ 用法: <code>${mainPrefix}panel admin add &lt;userid&gt; [备注]</code>`,
                parseMode: "html",
              });
              return;
            }
            const admins = await addPanelAdmin(uid, note);
            await msg.edit({
              text:
                `✅ 已添加 <code>${uid}</code>\n当前额外管理员 ${admins.length} 人`,
              parseMode: "html",
            });
            return;
          }
          if (action === "del" || action === "rm" || action === "remove") {
            const uid = Number(rest[1]);
            if (!Number.isFinite(uid) || uid <= 0) {
              await msg.edit({
                text:
                  `❌ 用法: <code>${mainPrefix}panel admin del &lt;userid&gt;</code>`,
                parseMode: "html",
              });
              return;
            }
            const admins = await removePanelAdmin(uid);
            await msg.edit({
              text:
                `✅ 已移除 <code>${uid}</code>\n当前额外管理员 ${admins.length} 人`,
              parseMode: "html",
            });
            return;
          }
          await msg.edit({
            text:
              `用法:\n<code>${mainPrefix}panel admin list</code>\n<code>${mainPrefix}panel admin add &lt;id&gt;</code>\n<code>${mainPrefix}panel admin del &lt;id&gt;</code>`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "open" || sub === "link") {
          const cfg = await readPanelConfig();
          if (!cfg.enabled) {
            await msg.edit({
              text: `❌ Panel 未开启，先 <code>${mainPrefix}panel on</code>`,
              parseMode: "html",
            });
            return;
          }
          // For cloudflare tunnel mode, use tunnelUrl if available
          const effectiveUrl = cfg.publicBaseUrl || cfg.tunnelUrl;
          if (!effectiveUrl) {
            await msg.edit({
              text:
                `❌ 未设置公网地址\n<code>${mainPrefix}panel url https://...</code> 或 <code>${mainPrefix}panel tunnel on</code>`,
              parseMode: "html",
            });
            return;
          }
          if (!isBotRunning()) {
            await msg.edit({
              text:
                `⚠️ Bot 未运行。检查 token 后重试 <code>${mainPrefix}panel on</code>`,
              parseMode: "html",
            });
            return;
          }
          await msg.edit({
            text:
              `✅ 在 Panel Bot 中发送 /start 或 /panel 即可打开小程序\n🔗 <code>${htmlEscape(effectiveUrl)}</code>`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "restart") {
          const cfg = await readPanelConfig();
          if (!cfg.enabled) {
            await msg.edit({ text: "❌ Panel 未开启", parseMode: "html" });
            return;
          }
          const result = await applyPanelRuntimeFromConfig();
          await msg.edit({
            text:
              `✅ 已重载\n• HTTP: ${result.http ? "✅" : "❌"} ${result.bind || ""}\n• Bot: ${result.bot ? "✅" : "❌"}`,
            parseMode: "html",
          });
          return;
        }

        await msg.edit({
          text: `❌ 未知子命令 <code>${htmlEscape(sub)}</code>\n\n${HELP}`,
          parseMode: "html",
        });
      } catch (e: unknown) {
        logger.error("[panel] command error", e);
        await msg.edit({
          text: `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`,
          parseMode: "html",
        });
      }
    },
  };
}

export default new PanelPlugin();