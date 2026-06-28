import "dotenv/config";
import { logger } from "@utils/logger"; // 引入 logger 以便尽早初始化
import { startRuntime } from "@utils/runtimeManager";
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