import "dotenv/config";
import axios from "axios";
import { logger } from "@utils/logger"; // 引入 logger 以便尽早初始化
import { startRuntime, shutdownRuntime } from "@utils/runtimeManager";
import { initPluginBaseConfig } from "@utils/pluginBase";
import "./hook/patches/telegram.patch";

initPluginBaseConfig();

// 配置全局 HTTP 代理 - 让所有 axios 请求走代理
// 支持环境变量：HTTP_PROXY, HTTPS_PROXY, NO_PROXY
const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const noProxy = process.env.NO_PROXY || process.env.no_proxy;

if (httpProxy || httpsProxy) {
  console.log(`[PROXY] HTTP_PROXY: ${httpProxy || "not set"}`);
  console.log(`[PROXY] HTTPS_PROXY: ${httpsProxy || "not set"}`);
  console.log(`[PROXY] NO_PROXY: ${noProxy || "not set"}`);

  // 解析代理 URL
  const parseProxy = (proxyUrl: string) => {
    const url = new URL(proxyUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10),
      protocol: url.protocol.replace(":", ""),
      auth: url.username ? {
        username: url.username,
        password: url.password || ""
      } : undefined
    };
  };

  if (httpsProxy) {
    axios.defaults.proxy = parseProxy(httpsProxy);
  } else if (httpProxy) {
    axios.defaults.proxy = parseProxy(httpProxy);
  }

  console.log("[PROXY] 全局代理配置已应用");
} else {
  console.log("[PROXY] 未检测到代理环境变量，使用直连");
}


// Global error handlers to prevent unhandled rejections and exceptions
// from crashing the process silently. These log the error for debugging.
// Note: We intentionally do NOT call process.exit() here — exiting on every
// unhandled rejection is too aggressive for a production bot with 120+ plugins
// where a single missing .catch() would crash the entire process. PM2's own
// restart strategy handles actual fatal crashes.
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[WARN] Unhandled promise rejection: ${message}`);
});

process.on("uncaughtException", (error: Error) => {
  console.error(`[ERROR] Uncaught exception: ${error.stack || error.message}`);
});

// Graceful shutdown: when PM2 sends SIGTERM (or systemd, docker stop, etc.),
// trigger the runtime's dispose chain so plugins can clean up resources
// (timers, listeners, child processes, temp files) before the process exits.
let shutdownInProgress = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);
  try {
    await shutdownRuntime();
    console.log("[SHUTDOWN] Runtime shutdown complete.");
  } catch (error) {
    console.error("[SHUTDOWN] Error during shutdown:", error);
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch((err: unknown) => {
    console.error("[SHUTDOWN] Unhandled error during SIGTERM handler:", err);
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch((err: unknown) => {
    console.error("[SHUTDOWN] Unhandled error during SIGINT handler:", err);
    process.exit(1);
  });
});

async function run() {
  try {
    await startRuntime();
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[FATAL] Runtime failed to start: ${message}`);
    process.exit(1);
  }
}

run();