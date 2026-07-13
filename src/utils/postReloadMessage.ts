/**
 * Post-reload / post-blocking-operation message helpers.
 *
 * After reloadRuntime() or long blocking work (npm install), message objects
 * hold a stale TelegramClient. Always snapshot peerId+msgId first, then use
 * a fresh client from getGlobalClient().
 *
 * Channel deletes need a resolvable peer (marked chat id / InputPeer with
 * access_hash). After reload the entity cache is empty — convert Peer* objects
 * to marked ids ("-100…") and retry; on final failure queue for next boot.
 */

import type { Api } from "teleproto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getGlobalClient } from "./runtimeAccess";

export type MessageEditOptions = {
  parseMode?: string;
  linkPreview?: boolean;
};

const PENDING_DELETE_FILE = path.join(
  os.homedir(),
  ".telebox",
  "pending_status_deletes.json",
);

interface PendingDelete {
  chatId: string;
  msgId: number;
  queuedAt: number;
}

/**
 * Edit-or-send a status message on the *current* client (pre-reload only).
 */
export async function sendOrEditMessage(
  msg: Api.Message,
  text: string,
  options?: MessageEditOptions,
): Promise<Api.Message> {
  const messageOptions = {
    text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  try {
    await msg.edit(messageOptions);
    return msg;
  } catch (error) {
    console.log(`[MSG] edit failed, sending new message: ${error}`);
  }

  const sendOptions: Record<string, unknown> = {
    message: text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  if (msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId) {
    sendOptions.replyTo =
      msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId;
  }

  const newMsg = await msg.client?.sendMessage(msg.peerId, sendOptions);
  return (newMsg as Api.Message) || msg;
}

/**
 * Snapshot peer/id → loadPlugins/reload → edit final status with fresh client.
 */
export async function reloadAndFinalize(
  statusMsg: Api.Message,
  finalText: string,
  options?: MessageEditOptions & {
    reload?: () => Promise<unknown>;
  },
): Promise<void> {
  const targetPeerId = statusMsg.peerId;
  const targetMsgId = statusMsg.id;
  const reload =
    options?.reload ??
    (async () => {
      const { loadPlugins } = require("./pluginManager") as typeof import("./pluginManager");
      return loadPlugins();
    });

  try {
    await reload();
  } catch (error) {
    console.error("[MSG] reload failed before finalize:", error);
  }

  try {
    const freshClient = (await getGlobalClient()) as {
      editMessage: (
        peer: unknown,
        opts: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    const peer = normalizeDeletePeer(targetPeerId) ?? targetPeerId;
    await freshClient.editMessage(peer, {
      message: targetMsgId,
      text: finalText,
      parseMode: options?.parseMode,
      linkPreview: options?.linkPreview !== false,
    });
  } catch (error) {
    console.log(`[MSG] final status edit failed (post-reload): ${error}`);
  }
}

/**
 * Convert teleproto Peer* / BigInt / number to a marked chat id string that
 * getInputEntity can resolve after reload (e.g. "-1003061608291").
 */
export function normalizeDeletePeer(peerId: unknown): string | null {
  if (peerId == null) return null;
  if (typeof peerId === "string" || typeof peerId === "number") {
    const s = String(peerId);
    return s.length > 0 ? s : null;
  }
  if (typeof peerId === "bigint") {
    return peerId.toString();
  }
  // BigInteger from teleproto Helpers
  if (
    typeof peerId === "object" &&
    peerId !== null &&
    "toString" in peerId &&
    typeof (peerId as { toString: () => string }).toString === "function" &&
    !("className" in peerId) &&
    !("channelId" in peerId) &&
    !("userId" in peerId) &&
    !("chatId" in peerId)
  ) {
    try {
      const s = (peerId as { toString: () => string }).toString();
      if (/^-?\d+$/.test(s)) return s;
    } catch {
      /* fall through */
    }
  }

  const p = peerId as {
    className?: string;
    channelId?: { toString(): string } | string | number;
    userId?: { toString(): string } | string | number;
    chatId?: { toString(): string } | string | number;
  };

  if (p.channelId != null) {
    return `-100${String(p.channelId)}`;
  }
  if (p.userId != null) {
    return String(p.userId);
  }
  if (p.chatId != null) {
    // basic group: marked as negative id
    const id = String(p.chatId);
    return id.startsWith("-") ? id : `-${id}`;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPeerId } = require("teleproto/Utils") as {
      getPeerId: (peer: unknown, addMark?: boolean) => string;
    };
    return String(getPeerId(peerId, true));
  } catch {
    return null;
  }
}

function loadPendingDeletes(): PendingDelete[] {
  try {
    if (!fs.existsSync(PENDING_DELETE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PENDING_DELETE_FILE, "utf8"));
    return Array.isArray(raw) ? (raw as PendingDelete[]) : [];
  } catch {
    return [];
  }
}

function savePendingDeletes(items: PendingDelete[]): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_DELETE_FILE), { recursive: true });
    fs.writeFileSync(
      PENDING_DELETE_FILE,
      JSON.stringify(items, null, 2),
      "utf8",
    );
  } catch (e) {
    console.error("[MSG] failed to save pending deletes:", e);
  }
}

export function queueStatusDelete(
  peerId: unknown,
  msgId: number,
): void {
  const chatId = normalizeDeletePeer(peerId);
  if (!chatId || !msgId) return;
  const items = loadPendingDeletes().filter(
    (x) => !(x.chatId === chatId && x.msgId === msgId),
  );
  items.push({ chatId, msgId, queuedAt: Date.now() });
  // keep last 50
  savePendingDeletes(items.slice(-50));
  console.log(`[MSG] queued status delete chat=${chatId} msg=${msgId}`);
}

/**
 * Delete a message by id with exponential backoff using a fresh client.
 * Use after blocking ops that may invalidate msg._client.
 */
export async function deleteStatusMessage(
  peerId: unknown,
  msgId: number,
  delays: number[] = [0, 2000, 4000, 8000, 15000],
): Promise<boolean> {
  const peer = normalizeDeletePeer(peerId) ?? peerId;
  if (peer == null || !msgId) return false;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const freshClient = (await getGlobalClient()) as {
        deleteMessages: (
          entity: unknown,
          ids: number[],
          opts?: { revoke?: boolean },
        ) => Promise<unknown>;
        connect?: () => Promise<void>;
        connected?: boolean;
      };

      // After long sync work the TCP session may be dead — try reconnect once
      if (attempt > 0 && typeof freshClient.connect === "function") {
        try {
          await freshClient.connect();
        } catch {
          /* ignore */
        }
      }

      await freshClient.deleteMessages(peer, [msgId], { revoke: true });
      console.log(`[MSG] status message deleted (attempt ${attempt + 1})`);
      // drop from pending if present
      const rest = loadPendingDeletes().filter(
        (x) =>
          !(
            x.msgId === msgId &&
            (x.chatId === String(peer) || x.chatId === normalizeDeletePeer(peerId))
          ),
      );
      if (rest.length !== loadPendingDeletes().length) savePendingDeletes(rest);
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[MSG] delete status message failed (attempt ${attempt + 1}):`,
        message,
      );
    }
  }
  console.error("[MSG] status message delete exhausted retries — queue for next boot");
  queueStatusDelete(peer, msgId);
  return false;
}

/**
 * Flush deletes that failed while the client was dead (e.g. after npm install + exit).
 * Call once after runtime is fully online.
 */
export async function flushPendingStatusDeletes(): Promise<void> {
  const items = loadPendingDeletes();
  if (items.length === 0) return;
  console.log(`[MSG] flushing ${items.length} pending status delete(s)`);
  const remaining: PendingDelete[] = [];
  for (const item of items) {
    // drop older than 7 days
    if (Date.now() - item.queuedAt > 7 * 24 * 3600 * 1000) continue;
    try {
      const client = (await getGlobalClient()) as {
        deleteMessages: (
          entity: unknown,
          ids: number[],
          opts?: { revoke?: boolean },
        ) => Promise<unknown>;
      };
      await client.deleteMessages(item.chatId, [item.msgId], { revoke: true });
      console.log(
        `[MSG] pending delete ok chat=${item.chatId} msg=${item.msgId}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[MSG] pending delete still failing chat=${item.chatId} msg=${item.msgId}:`,
        message,
      );
      remaining.push(item);
    }
  }
  savePendingDeletes(remaining);
}
