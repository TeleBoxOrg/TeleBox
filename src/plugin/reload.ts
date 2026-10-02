import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import type { EntityLike } from "teleproto/define";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCurrentGenerationContext } from "@utils/runtimeManager";
import { reloadRuntime } from "@utils/runtimeManager";
import { htmlEscape } from "@utils/htmlEscape";
import {
  normalizeDeletePeer,
  restoreInputPeer,
  snapshotInputPeer,
} from "@utils/postReloadMessage";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execFileAsync = promisify(execFile);

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

/**
 * Persist a stable peer key for post-restart editMessage.
 * NEVER JSON-serialize PeerUser/PeerChannel objects — after process restart the
 * entity cache is empty and Peer* without accessHash fails getInputEntity:
 *   Could not find the input entity for {"userId":"…","className":"PeerUser"}
 */
function resolvePersistableChatId(msg: Api.Message, result?: Api.Message | boolean | null): string {
  const candidates: unknown[] = [
    result && typeof result === "object" ? (result as Api.Message).chatId : undefined,
    result && typeof result === "object" ? (result as Api.Message).peerId : undefined,
    msg.chatId,
    msg.peerId,
  ];
  for (const c of candidates) {
    const n = normalizeDeletePeer(c);
    if (n) return n;
  }
  // last resort: plain string of chatId
  if (msg.chatId != null) return String(msg.chatId);
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One status message per command run. Prefers editing the user's command
 * message (self-message in Saved Messages); falls back to a fresh reply only
 * when the edit is rejected — a forwarded command message cannot be edited
 * by this account (MESSAGE_AUTHOR_REQUIRED), which is the one legitimate
 * case for a second message. Every later progress edit targets the SAME
 * message, so a full update/restart cycle never spawns extra messages.
 */
export async function ensureStatusMessage(
  client: Api.Message["client"],
  msg: Api.Message,
  initialText: string
): Promise<Api.Message> {
  try {
    await msg.edit({ text: initialText });
    return msg;
  } catch (editError) {
    console.warn("[RELOAD] 编辑原消息失败，改为发送新状态消息:", editError);
    return await client?.sendMessage(msg.chatId ?? msg.peerId, {
      message: initialText,
      replyTo: msg.id,
    }) as Api.Message;
  }
}

const editExitMsg = async () => {
  if (!fs.existsSync(exitFile)) return;
  let payload: {
    messageId?: number;
    chatId?: unknown;
    inputPeer?: unknown;
    time?: number;
    successText?: string;
    parseMode?: "html" | "markdown";
  };
  try {
    payload = JSON.parse(fs.readFileSync(exitFile, "utf-8"));
  } catch (e) {
    console.error("Failed to parse exit message file:", e);
    try {
      fs.unlinkSync(exitFile);
    } catch {
      /* ignore */
    }
    return;
  }

  const messageId = Number(payload.messageId);
  const rawChatId = payload.chatId;
  // Bare ids only resolve for self/contacts after restart; prefer the
  // persisted InputPeer (carries access_hash) so bot/user chats work too.
  const inputPeer = restoreInputPeer(payload.inputPeer);
  // Normalize legacy Peer* objects that may already be on disk
  const chatId =
    normalizeDeletePeer(rawChatId) ||
    (typeof rawChatId === "string" || typeof rawChatId === "number"
      ? String(rawChatId)
      : rawChatId && typeof rawChatId === "object" && (rawChatId as { userId?: unknown }).userId != null
        ? String((rawChatId as { userId: unknown }).userId)
        : "");
  if (!chatId || !Number.isFinite(messageId)) {
    try {
      fs.unlinkSync(exitFile);
    } catch {
      /* ignore */
    }
    return;
  }

  const elapsedMs = Date.now() - (Number(payload.time) || Date.now());
  const tmpl: string = payload.successText || "✅ 重启完成，耗时 {elapsedMs}ms";
  const text = tmpl.replace(/\{elapsedMs\}/g, String(elapsedMs));
  const parseMode = payload.parseMode;

  // Wait for runtime client + session entity cache (restart is racy)
  const delays = [0, 1500, 3000, 6000, 12000];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      const client = await getGlobalClient();
      if (!client) {
        lastErr = new Error("client not ready");
        continue;
      }
      // Prefer InputPeer with access_hash; fall back to marked/numeric id
      try {
        await client.editMessage(inputPeer ?? chatId, {
          message: messageId,
          text,
          ...(parseMode ? { parseMode } : {}),
        });
        fs.unlinkSync(exitFile);
        return;
      } catch (editErr) {
        lastErr = editErr;
        // Fallback: resolve via getEntity only when chatId is a plain id/string
        try {
          const entity = await client.getEntity(chatId);
          await client.editMessage(entity, {
            message: messageId,
            text,
            ...(parseMode ? { parseMode } : {}),
          });
          fs.unlinkSync(exitFile);
          return;
        } catch (entityErr) {
          lastErr = entityErr;
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }

  // Final fallback: send a new status message so the user still sees success
  try {
    const client = await getGlobalClient();
    if (client) {
      await client.sendMessage(inputPeer ?? chatId, {
        message: text,
        ...(parseMode ? { parseMode } : {}),
      });
    }
  } catch (sendErr) {
    console.error("Failed to edit/send exit message after retries:", lastErr || sendErr);
  }
  try {
    fs.unlinkSync(exitFile);
  } catch {
    /* ignore */
  }
};

if (fs.existsSync(exitFile)) {
  // Defer until after client.connect(); editExitMsg itself retries with backoff.
  setTimeout(() => {
    editExitMsg().catch((e) => console.error("Failed to handle exit message on startup:", e));
  }, 2000);
}

export async function executeExit(
  msg: Api.Message,
  options?: {
    statusMessage?: Api.Message;
    pendingText?: string;
    successText?: string;
    parseMode?: "html" | "markdown";
  }
) {
  const pendingText = options?.pendingText ?? "🔄 正在结束进程...";
  // Reuse the run's status message when provided (update flow keeps ONE
  // message for the whole cycle); otherwise edit the command message itself.
  const target = options?.statusMessage ?? msg;
  const editOpts = {
    text: pendingText,
    ...(options?.parseMode ? { parseMode: options.parseMode } : {}),
  };
  let result: Api.Message | undefined;
  try {
    result = await target.edit(editOpts);
  } catch (editError) {
    // Forwarded command messages can't be edited by this account — degrade:
    // the other candidate message, then a fresh message so restart still reports.
    console.warn("[RELOAD] 状态消息编辑失败，降级处理:", editError);
    if (target !== msg) {
      try {
        result = await msg.edit(editOpts);
      } catch {
        /* fall through to sendMessage */
      }
    }
    if (!result) {
      const client = await getGlobalClient();
      result = (await client.sendMessage(msg.chatId ?? msg.peerId, {
        message: pendingText,
        ...(options?.parseMode ? { parseMode: options.parseMode } : {}),
      })) as Api.Message;
    }
  }
  const messageId =
    result && typeof result === "object" && "id" in result
      ? Number((result as Api.Message).id)
      : Number(msg.id);
  const chatId = resolvePersistableChatId(
    msg,
    result && typeof result === "object" ? (result as Api.Message) : undefined,
  );
  const inputPeer = await snapshotInputPeer(
    result && typeof result === "object" ? (result as Api.Message) : msg,
  ) ?? await snapshotInputPeer(msg);
  if (Number.isFinite(messageId) && chatId) {
    fs.writeFileSync(
      exitFile,
      JSON.stringify({
        messageId,
        chatId, // always a marked/numeric string — never Peer* object
        inputPeer,
        time: Date.now(),
        successText: options?.successText,
        parseMode: options?.parseMode,
      }),
      "utf-8",
    );
  } else {
    console.warn("[RELOAD] executeExit: could not persist exit status peer/messageId");
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
      const client = await getGlobalClient();
      const statusMessage = await ensureStatusMessage(client, msg, "🔄 正在重新加载插件...");
      const targetChat =
        resolvePersistableChatId(msg, statusMessage as Api.Message | undefined) ||
        statusMessage?.chatId ||
        msg.chatId ||
        msg.peerId;
      const targetMessageId = statusMessage?.id || msg.id;
      try {
        const startTime = Date.now();
        const runtime = await reloadRuntime();
        const loadTime = Date.now() - startTime;
        try {
          const { noteReloadCompleted } = require("./memory");
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
      await msg.delete({ revoke: false });
      scheduleTrackedTimeout(async () => {
        try {
          await execFileAsync("pm2", ["restart", "telebox"]);
        } catch (error) {
          console.error("PM2 restart failed:", error);
        }
      }, 500);
    },
  };
}

export default new ReloadPlugin();
