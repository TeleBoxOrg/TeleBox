import "dotenv/config";
import { logger } from "@utils/logger"; // 引入 logger 以便尽早初始化
import { startRuntime } from "@utils/runtimeManager";
import { patchMsgEdit } from "hook/listen";
import "./hook/patches/telegram.patch";

// patchMsgEdit();

// Global error handlers to prevent unhandled rejections and exceptions
// from crashing the process silently. These log the error and let PM2
// restart if needed, rather than losing all context.
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[FATAL] Unhandled promise rejection: ${message}`);
  // Exit so PM2 can restart with a clean state rather than running in a broken state
  process.exit(1);
});

process.on("uncaughtException", (error: Error) => {
  console.error(`[FATAL] Uncaught exception: ${error.stack || error.message}`);
  // Exit after logging so PM2 can restart cleanly
  process.exit(1);
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