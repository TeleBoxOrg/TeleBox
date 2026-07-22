/**
 * TeleBox Panel — runtime controller (start/stop http+bot from config).
 * Self-healing: port auto-retry, bot token validation, tunnel retry + persistence.
 */

import { logger } from "@utils/logger";
import { readPanelConfig, updatePanelConfig } from "./configStore";
import { startHttpServer, stopHttpServer, isHttpRunning, getHttpMeta } from "./httpServer";
import { startPanelBot, stopPanelBot, isBotRunning } from "./botService";
import {
  registerBuiltinPanelProviders,
  unregisterBuiltinPanelProviders,
} from "./builtinProviders";
import { startTunnel, stopTunnel, getTunnelUrl, isTunnelRunning } from "./cloudflareTunnel";

let providersReady = false;
let applying: Promise<void> | null = null;

export function ensurePanelProviders(): void {
  if (providersReady) return;
  registerBuiltinPanelProviders();
  providersReady = true;
}

export function teardownPanelProviders(): void {
  if (!providersReady) return;
  unregisterBuiltinPanelProviders();
  providersReady = false;
}

export async function applyPanelRuntimeFromConfig(): Promise<{
  enabled: boolean;
  http: boolean;
  bot: boolean;
  bind: string | null;
  tunnelRunning: boolean;
  tunnelUrl: string | null;
  warnings: string[];
}> {
  if (applying) {
    await applying;
  }
  let resolve!: () => void;
  applying = new Promise<void>((r) => {
    resolve = r;
  });
  try {
    ensurePanelProviders();
    const cfg = await readPanelConfig();
    const warnings: string[] = [];

    // 1) Stop any existing tunnel first
    stopTunnel();

    if (!cfg.enabled) {
      await stopPanelBot();
      await stopHttpServer();
      return {
        enabled: false,
        http: false,
        bot: false,
        bind: null,
        tunnelRunning: false,
        tunnelUrl: null,
        warnings,
      };
    }

    // 2) Validate bot token early - clear warning if set
    if (!cfg.botToken) {
      warnings.push("未设置 bot token（.panel set <token>）");
    }

    // 3) Start HTTP server FIRST (tunnel needs a target to proxy)
    // Uses self-healing port retry (see httpServer.ts)
    try {
      await startHttpServer(cfg.bindHost || "0.0.0.0", cfg.bindPort || 8787);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`HTTP 启动失败: ${msg}`);
      logger.error("[panel] http start failed", e);
    }

    // 4) Handle tunnel mode - robust start with retries + URL persistence
    // Only proceed with tunnel/bot if botToken is configured
    if (cfg.botToken) {
      // Import startTunnelRobust dynamically to avoid circular dependency
      const { startTunnelRobust } = await import("./httpServer");
      
      if (cfg.tunnelMode === "cloudflare") {
        // Start tunnel robustly with retries
        const tunnelUrl = await startTunnelRobust(cfg.bindPort || 8787);
        if (tunnelUrl) {
          // URL already persisted by startTunnelRobust
          logger.info(`[panel] Cloudflare Tunnel ready: ${tunnelUrl}`);
          // Remove the "starting" warning and add success
          const idx = warnings.findIndex((w) => w.includes("后台启动中"));
          if (idx >= 0) warnings.splice(idx, 1);
        } else {
          warnings.push("❌ Cloudflare Tunnel 启动失败（已重试多次）");
        }
      } else if (cfg.tunnelMode === "manual") {
        if (!cfg.publicBaseUrl) {
          warnings.push("手动模式下未设置公网 HTTPS（.panel url https://...）");
        } else if (!/^https:\/\//i.test(cfg.publicBaseUrl)) {
          warnings.push("publicBaseUrl 必须是 https:// 开头");
        }
      } else {
        // tunnelMode === "off"
        if (!cfg.publicBaseUrl) {
          warnings.push("未设置公网 HTTPS（.panel url https://...）— 小程序按钮将不可用");
        } else if (!/^https:\/\//i.test(cfg.publicBaseUrl)) {
          warnings.push("publicBaseUrl 必须是 https:// 开头");
        }
      }

      // 5) Start bot AFTER HTTP + tunnel are set up (bot needs publicBaseUrl for WebApp button)
      try {
        await startPanelBot();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`Bot 启动失败: ${msg}`);
        logger.error("[panel] bot start failed", e);
      }
    }

    const meta = getHttpMeta();
    return {
      enabled: true,
      http: isHttpRunning(),
      bot: isBotRunning(),
      bind: meta ? `${meta.host}:${meta.port}` : null,
      tunnelRunning: isTunnelRunning(),
      tunnelUrl: getTunnelUrl(),
      warnings,
    };
  } finally {
    resolve();
    applying = null;
  }
}

export async function shutdownPanelRuntime(): Promise<void> {
  await stopPanelBot();
  await stopHttpServer();
  stopTunnel();
  teardownPanelProviders();
}