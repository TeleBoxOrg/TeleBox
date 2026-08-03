/**
 * TeleBox Panel — Telegram Chat Menu Button 绑定 / 清除。
 *
 * 负责在 bot 私聊右下角的 ☰ 菜单按钮同步放置/移除 Web App 入口。
 * URL 改了会自动重绑（由 controller 在 applyPanelRuntimeFromConfig 末尾统一调用）。
 * 失败仅 warn，不阻塞主流程。
 */
import type { Telegraf } from "telegraf";

import { logger } from "@utils/logger";
import type { PanelConfig } from "./types";

export interface MenuButtonState {
  /** 最近一次 setChatMenuButton 是否成功 */
  bound: boolean;
  /** 已绑定的 https URL；未绑定时为空字符串 */
  url: string;
  /** 绑定的按钮文本（displayName 或 fallback） */
  text?: string;
  /** 成功绑定的 ms 时间戳 */
  at?: number;
  /** 最近一次失败原因（成功时无） */
  error?: string;
}

let lastBound: MenuButtonState = { bound: false, url: "" };

/**
 * 把 cfg.publicBaseUrl 规范化成 Telegram WebApp 要求的根路径 URL。
 * 与 botService 历史的 buildOpenKeyboard 同一公式，避免重复实现。
 */
export function webAppUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/";
}

/** 当前本地状态快照（同步）。状态汇报 / .panel status 调用。 */
export function getMenuButtonState(): MenuButtonState {
  return { ...lastBound };
}

/**
 * 安装（绑定或按需重绑）Chat Menu Button。
 * - 关闭 / 无 token / 无 URL → 走清除路径（让 Telegram 恢复默认按钮）
 * - 非 https → 跳过 API，仅 warn + 记录状态
 * - instance 为 null → 跳过 API，仅更新本地状态
 * - 任何异常 → catch + warn，不抛
 */
export async function applyMenuButton(
  instance: Telegraf | null,
  cfg: PanelConfig,
): Promise<MenuButtonState> {
  // 关闭 / 无 token / 无 URL → 主动清除（满足"URL 为空时清除"语义）
  if (!cfg.enabled || !cfg.botToken || !cfg.publicBaseUrl) {
    return await clearMenuButton(instance);
  }

  // HTTPS 强制（Telegram Bot API 拒绝 http://）
  if (!/^https:\/\//i.test(cfg.publicBaseUrl)) {
    const msg = "URL must be https://";
    logger.warn(`[panel-menubtn] skipped: ${msg} (got: ${cfg.publicBaseUrl})`);
    lastBound = { bound: false, url: cfg.publicBaseUrl, error: msg };
    return lastBound;
  }

  // 缺少 bot 实例：仅写本地状态（用于状态上报），不发起 API
  if (!instance) {
    const msg = "no bot instance";
    logger.warn(`[panel-menubtn] skipped: ${msg}`);
    lastBound = { bound: false, url: "", error: msg };
    return lastBound;
  }

  const text = (cfg.displayName || "TeleBox Panel").slice(0, 64);
  const url = webAppUrl(cfg.publicBaseUrl);

  try {
    await instance.telegram.setChatMenuButton({
      menuButton: { type: "web_app", text, web_app: { url } },
    });
    lastBound = { bound: true, url, text, at: Date.now() };
    logger.info(`[panel-menubtn] set ok: ${url}`);
    return lastBound;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[panel-menubtn] set failed: ${msg}`);
    lastBound = { bound: false, url, error: msg };
    return lastBound;
  }
}

/**
 * 移除 Chat Menu Button，恢复 Telegram 默认（"分享我的联系方式"等）。
 * - instance 为 null 时仍清本地状态（远端会保留上次设置直到下次 apply 覆盖）
 * - 任何异常 → catch + warn，不抛
 */
export async function clearMenuButton(
  instance: Telegraf | null,
): Promise<MenuButtonState> {
  if (instance) {
    try {
      await instance.telegram.setChatMenuButton({
        menuButton: { type: "default" },
      });
      logger.info("[panel-menubtn] clear ok");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[panel-menubtn] clear failed: ${msg}`);
      // 不抛。本地状态仍清零（下次 apply 会基于新 cfg 重新决定）。
    }
  } else {
    logger.warn("[panel-menubtn] clear skipped: no bot instance");
  }
  lastBound = { bound: false, url: "" };
  return lastBound;
}
