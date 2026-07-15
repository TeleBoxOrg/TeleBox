import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import type { EntityLike } from "teleproto/define";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { exec } from "child_process";
import { promisify } from "util";
import { getCurrentGenerationContext } from "@utils/runtimeManager";
import { reloadRuntime } from "@utils/runtimeManager";
import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execAsync = promisify(exec);

const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");
const pendingExitTimers = new Set<ReturnType<typeof setTimeout>>();

async function updateReloadStatus(params: {
  client: Api.Message["client"];
  targetChat: EntityLike | number | string;
  targetMessageId: number;
  text: string;
  parseMode?: "html";
}) {
  const { client, targetChat, targetMessageId, text, parseMode } = params;
  try {
    await client?.editMessage(targetChat, {
      message: targetMessageId,
      text,
      parseMode,
    });
  } catch (error) {
    console.error("Failed to edit reload status message, falling back to sendMessage:", error);
    try {
      await client?.sendMessage(targetChat, {
        message: text,
        parseMode,
      });
    } catch (sendError) {
      console.error("Fallback sendMessage also failed (client may be destroyed):", sendError);
    }
  }
}

function scheduleTrackedTimeout(
  callback: () => void | Promise<void>,
  delay: number
): ReturnType<typeof setTimeout> {
  let timer: ReturnType<typeof setTimeout>;
  const context = getCurrentGenerationContext();
  timer = context.setTimeout(() => {
    pendingExitTimers.delete(timer);
    const task = Promise.resolve(callback());
    context.trackTask(task, { label: "reload:scheduled-timeout" });
    task.catch((error) => {
      console.error("[RELOAD] Scheduled timeout failed:", error);
    });
  }, delay, { label: "reload:scheduled-timeout" });
  pendingExitTimers.add(timer);
  return timer;
}

const editExitMsg = async () => {
  try {
    const data = fs.readFileSync(exitFile, "utf-8");
    const { messageId, chatId, time, successText, parseMode } = JSON.parse(data);
    const client = await getGlobalClient();
    if (client) {
      let targetChat: EntityLike | number | string = chatId;
      try {
        targetChat = await client.getEntity(chatId);
      } catch (innerE) {
        console.error("Failed to resolve entity for exit message:", innerE);
      }
      const elapsedMs = Date.now() - time;
      const tmpl: string = successText || "✅ 重启完成，耗时 {elapsedMs}ms";
      const text = tmpl.replace(/\{elapsedMs\}/g, String(elapsedMs));
      await client.editMessage(targetChat, {
        message: messageId,
        text,
        ...(parseMode ? { parseMode } : {}),
      });
      fs.unlinkSync(exitFile);
    }
  } catch (e) {
    console.error("Failed to edit exit message:", e);
  }
};

if (fs.existsSync(exitFile)) {
  editExitMsg().catch((e) => console.error("Failed to handle exit message on startup:", e));
}

export async function executeExit(
  msg: Api.Message,
  options?: {
    pendingText?: string;
    successText?: string;
    parseMode?: "html" | "markdown";
  }
) {
  const pendingText = options?.pendingText ?? "🔄 正在结束进程...";
  const result = await msg.edit({
    text: pendingText,
    ...(options?.parseMode ? { parseMode: options.parseMode } : {}),
  });
  if (result) {
    fs.writeFileSync(
      exitFile,
      JSON.stringify({
        messageId: result.id,
        chatId: result.chatId || result.peerId,
        time: Date.now(),
        successText: options?.successText,
        parseMode: options?.parseMode,
      }),
      "utf-8"
    );
  }
  process.exit(0);
}

const HELP_TEXT = `🔄 Reload · 重载与重启

• <code>${mainPrefix}reload</code> — 重新加载插件（一般不重启整个程序）
• <code>${mainPrefix}exit</code> / <code>${mainPrefix}restart</code> — 退出进程，PM2 会自动再启动
• <code>${mainPrefix}pmr</code> — 让 PM2 直接重启本进程

🩺 想管内存 / 自动保护？用：
• <code>${mainPrefix}health</code> — 看内存
• <code>${mainPrefix}memory on</code> — 打开自动保护
• <code>${mainPrefix}memory</code> — 完整说明（小白友好）
`;

class ReloadPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingExitTimers) {
      clearTimeout(timer);
    }
    pendingExitTimers.clear();
  }

  description = HELP_TEXT;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    reload: async (msg) => {
      const statusMessage = await msg.edit({ text: "🔄 正在重新加载插件..." });
      const targetChat = statusMessage?.chatId || statusMessage?.peerId || msg.chatId || msg.peerId;
      const targetMessageId = statusMessage?.id || msg.id;
      try {
        const startTime = Date.now();
        const runtime = await reloadRuntime();
        const loadTime = Date.now() - startTime;
        try {
          const { noteReloadCompleted } = await import("./health");
          await noteReloadCompleted();
        } catch (e) {
          console.warn("[RELOAD] noteReloadCompleted:", e);
        }
        await updateReloadStatus({
          client: runtime.client,
          targetChat,
          targetMessageId,
          text: `✅ 重载完成，耗时 ${loadTime}ms`,
          parseMode: "html",
        });
      } catch (error) {
        console.error("Plugin reload failed:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          const client = await getGlobalClient();
          await updateReloadStatus({
            client,
            targetChat,
            targetMessageId,
            text: `❌ 插件重新加载失败\n错误信息：${htmlEscape(errorMessage)}\n请检查控制台日志获取详细信息`,
          });
        } catch (editError) {
          console.error("Failed to update reload status message:", editError);
        }
      }
    },

    exit: async (msg) => {
      await executeExit(msg);
    },

    restart: async (msg) => {
      await executeExit(msg);
    },

    pmr: async (msg) => {
      await msg.delete();
      scheduleTrackedTimeout(async () => {
        try {
          await execAsync("pm2 restart telebox");
        } catch (error) {
          console.error("PM2 restart failed:", error);
        }
      }, 500);
    },
  };
}

export default new ReloadPlugin();
