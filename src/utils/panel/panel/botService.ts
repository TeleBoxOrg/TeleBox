/**
 * TeleBox Panel — companion Bot (telegraf) that opens the WebApp.
 */

import { Telegraf, Markup } from "telegraf";
import { logger } from "@utils/logger";
import { readPanelConfig } from "./configStore";
import { isPanelAdminUser } from "./auth";
import { getOwnerId } from "./owner";

let bot: Telegraf | null = null;
let botTokenRunning = "";
let launching: Promise<void> | null = null;

function webAppUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/";
}

function buildOpenKeyboard(baseUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp("打开管理面板", webAppUrl(baseUrl))],
  ]);
}

export function isBotRunning(): boolean {
  return !!bot;
}

export async function startPanelBot(): Promise<void> {
  if (launching) return launching;
  launching = (async () => {
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

    const instance = new Telegraf(cfg.botToken);
    const token = cfg.botToken;

    instance.start(async (ctx) => {
      try {
        const uid = ctx.from?.id;
        if (!uid) return;
        const gate = await isPanelAdminUser(uid);
        const latest = await readPanelConfig();
        if (!gate.allowed) {
          await ctx.reply(
            "⛔ 你没有 TeleBox Panel 管理权限。\n请联系 owner 使用 `.panel admin add <userid>` 授权。",
          );
          return;
        }
        if (!latest.publicBaseUrl) {
          await ctx.reply(
            "⚠️ Panel 已启用，但未设置公网 HTTPS 地址。\n" +
              "请在 userbot 中执行：\n" +
              "`.panel url https://你的域名`\n" +
              "Telegram 小程序要求公网 HTTPS。",
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
          },
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
        ].join("\n"),
      );
    });

    instance.catch((err) => {
      logger.error("[panel-bot] telegraf error", err);
    });

    // Launch without blocking forever — telegraf launch resolves when aborted.
    void instance.launch({ dropPendingUpdates: true }).catch((e: unknown) => {
      logger.error("[panel-bot] launch failed", e);
      if (bot === instance) {
        bot = null;
        botTokenRunning = "";
      }
    });

    bot = instance;
    botTokenRunning = token;
    logger.info("[panel-bot] started");
  })().finally(() => {
    launching = null;
  });
  return launching;
}

export async function stopPanelBot(): Promise<void> {
  const instance = bot;
  bot = null;
  botTokenRunning = "";
  if (!instance) return;
  try {
    instance.stop("panel-stop");
  } catch (e: unknown) {
    logger.warn("[panel-bot] stop error", e);
  }
  logger.info("[panel-bot] stopped");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
