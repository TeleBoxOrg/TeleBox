import "dotenv/config";
import { logger } from "@utils/logger"; // 引入 logger 以便尽早初始化
import { startRuntime, shutdownRuntime } from "@utils/runtimeManager";
import "./hook/patches/telegram.patch";

// patchMsgEdit();

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