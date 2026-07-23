/**
 * TeleBox Panel — companion Bot (telegraf) that opens the WebApp.
 * Properly handles bot lifecycle to avoid 409 Conflict on restart.
 */

import { Telegraf, Markup } from "telegraf";
import { logger } from "@utils/logger";
import { readPanelConfig } from "./configStore";
import { isPanelAdminUser } from "./auth";
import { getOwnerId } from "./owner";

let bot: Telegraf | null = null;
let botTokenRunning = "";
let launchPromise: Promise<void> | null = null;

function webAppUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/";
}

function buildOpenKeyboard(baseUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp("打开管理面板", webAppUrl(baseUrl))],
  ]);
}

/**
 * Get HTTP/HTTPS agent with proxy from environment variables.
 * Supports HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and SOCKS_PROXY.
 */
function getProxyAgent(): any | undefined {
  // Check standard env vars (case-insensitive)
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;
  const socksProxy = process.env.SOCKS_PROXY || process.env.socks_proxy;

  // For HTTPS requests (Telegram Bot API uses HTTPS), prefer HTTPS_PROXY
  const proxyUrl = httpsProxy || httpProxy || allProxy || socksProxy;
  if (!proxyUrl) return undefined;

  try {
    const url = new URL(proxyUrl);
    const host = url.hostname;
    const port = Number(url.port);
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    if (!host || !port) {
      logger.warn("[panel-bot] 环境变量代理 URL 格式无效，缺少 host 或 port:", proxyUrl);
      return undefined;
    }

    const protocol = url.protocol.toLowerCase();

    // For telegraf, we need an HTTP/HTTPS agent
    // SOCKS proxies need special handling (e.g., socks-proxy-agent package)
    if (protocol === "socks5:" || protocol === "socks4:") {
      logger.warn(
        "[panel-bot] SOCKS 代理需要 socks-proxy-agent 包支持，当前仅支持 HTTP/HTTPS 代理。建议配置 HTTP_PROXY/HTTPS_PROXY 环境变量。"
      );
      return undefined;
    }

    if (protocol === "http:" || protocol === "https:") {
      const auth = username && password ? `${username}:${password}@` : "";
      const proxyAddress = `${protocol}//${auth}${host}:${port}`;

      // Use http-proxy-agent for HTTP/HTTPS proxy
      const { HttpProxyAgent } = require("http-proxy-agent");

      return new HttpProxyAgent(proxyAddress);
    }

    logger.warn("[panel-bot] 不支持的代理协议:", protocol);
    return undefined;
  } catch (e: unknown) {
    logger.warn("[panel-bot] 解析环境变量代理失败:", e);
    return undefined;
  }
}

export function isBotRunning(): boolean {
  return !!bot;
}

export async function startPanelBot(): Promise<void> {
  const cfg = await readPanelConfig();
  if (!cfg.enabled) {
    await stopPanelBot();
    return;
  }
  if (!cfg.botToken) {
    logger.warn("[panel-bot] enabled but botToken empty — skip start");
    await stopPanelBot();
    return;
  }
  if (bot && botTokenRunning === cfg.botToken) {
    return;
  }
  await stopPanelBot();

  const proxyAgent = getProxyAgent();
  const instance = new Telegraf(cfg.botToken, {
    telegram: proxyAgent
      ? {
          agent: proxyAgent,
        }
      : undefined,
  });
  const token = cfg.botToken;

  instance.start(async (ctx) => {
    try {
      const uid = ctx.from?.id;
      if (!uid) return;
      const gate = await isPanelAdminUser(uid);
      const latest = await readPanelConfig();
      if (!gate.allowed) {
        await ctx.reply(
          "⛔ 你没有 TeleBox Panel 管理权限。\n请联系 owner 使用 `.panel admin add <userid>` 授权。"
        );
        return;
      }
      if (!latest.publicBaseUrl) {
        await ctx.reply(
          "⚠️ Panel 已启用，但未设置公网 HTTPS 地址。\n" +
            "请在 userbot 中执行：\n" +
            "`.panel url https://你的域名`\n" +
            "Telegram 小程序要求公网 HTTPS。"
        );
        return;
      }
      const name = latest.displayName || "TeleBox Panel";
      await ctx.reply(
        `🎛️ <b>${escapeHtml(name)}</b>\n` +
          `你好 ${escapeHtml(ctx.from.first_name || "")}！\n` +
          `点击下方按钮打开管理面板。`,
        {
          parse_mode: "HTML",
          ...buildOpenKeyboard(latest.publicBaseUrl),
        }
      );
    } catch (e: unknown) {
      logger.error("[panel-bot] /start failed", e);
    }
  });

  instance.command("panel", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const gate = await isPanelAdminUser(uid);
    if (!gate.allowed) {
      await ctx.reply("⛔ 无权限");
      return;
    }
    const latest = await readPanelConfig();
    if (!latest.publicBaseUrl) {
      await ctx.reply("⚠️ 未设置 publicBaseUrl，无法打开小程序");
      return;
    }
    await ctx.reply("🎛️ 打开 TeleBox 管理面板：", {
      ...buildOpenKeyboard(latest.publicBaseUrl),
    });
  });

  instance.command("whoami", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const gate = await isPanelAdminUser(uid);
    const ownerId = await getOwnerId();
    await ctx.reply(
      [
        `userId: ${uid}`,
        `username: @${ctx.from.username || "-"}`,
        `panelAdmin: ${gate.allowed ? "yes" : "no"}`,
        `isOwner: ${gate.isOwner ? "yes" : "no"}`,
        `ownerId: ${ownerId ?? "unknown"}`,
      ].join("\n")
    );
  });

  instance.catch((err) => {
    logger.error("[panel-bot] telegraf error", err);
  });

  // Launch and track the promise — it resolves when bot is stopped
  launchPromise = instance.launch({ dropPendingUpdates: true }).then(
    () => {
      logger.info("[panel-bot] launch promise resolved (bot stopped)");
    },
    (e: unknown) => {
      logger.error("[panel-bot] launch failed", e);
    }
  );

  bot = instance;
  botTokenRunning = token;
  logger.info("[panel-bot] started");
}

export async function stopPanelBot(): Promise<void> {
  const instance = bot;
  bot = null;
  botTokenRunning = "";
  if (!instance) return;

  try {
    // Signal the polling loop to stop
    instance.stop("panel-stop");
  } catch (e: unknown) {
    logger.warn("[panel-bot] stop error", e);
  }

  // Wait for the launch promise to resolve (polling actually stopped)
  if (launchPromise) {
    try {
      await Promise.race([
        launchPromise,
        new Promise((r) => setTimeout(r, 3000)), // fallback timeout
      ]);
    } catch {
      // ignore timeout
    }
    launchPromise = null;
  }

  // Small delay to ensure Telegram sees the connection fully closed
  await new Promise((r) => setTimeout(r, 500));

  logger.info("[panel-bot] stopped");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """);
}