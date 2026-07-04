import { Api } from "teleproto";
import { isoFromUnixSeconds } from "./dateRange";
import { safeJsonStringify, toIdString, toNumber } from "./json";
import type { LeechChatIdentity, LeechStoredMessage } from "./types";

function getClassName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return (value as { className?: string }).className ?? value.constructor?.name ?? null;
}

function inferMediaType(msg: Api.Message): string | null {
  const anyMsg = msg as any;
  if (!anyMsg.media) return null;
  return getClassName(anyMsg.media);
}

function getSenderName(sender: any): string | null {
  if (!sender) return null;
  if (sender.title) return sender.title;
  const parts = [sender.firstName, sender.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function buildRawMessageSnapshot(msg: Api.Message): Record<string, unknown> {
  const anyMsg = msg as any;
  return {
    className: anyMsg.className,
    id: anyMsg.id,
    date: anyMsg.date,
    editDate: anyMsg.editDate,
    message: anyMsg.message,
    senderId: toIdString(anyMsg.senderId),
    chatId: toIdString(anyMsg.chatId),
    peerId: toIdString(anyMsg.peerId),
    replyTo: anyMsg.replyTo,
    fwdFrom: anyMsg.fwdFrom,
    mediaClassName: getClassName(anyMsg.media),
    entities: anyMsg.entities,
    groupedId: toIdString(anyMsg.groupedId),
    postAuthor: anyMsg.postAuthor,
    views: anyMsg.views,
    forwards: anyMsg.forwards,
    out: Boolean(anyMsg.out),
    mentioned: Boolean(anyMsg.mentioned),
    post: Boolean(anyMsg.post),
  };
}

/**
 * Convert a Telegram message into a stable SQLite row.
 * 将 Telegram 消息转换为稳定的 SQLite 行，避免把 client/circular object 存入 DB。
 */
export function serializeLeechMessage(
  msg: Api.Message,
  chat: LeechChatIdentity,
  jobId: number
): LeechStoredMessage | null {
  const anyMsg = msg as any;
  const messageId = toNumber(anyMsg.id);
  const dateTs = toNumber(anyMsg.date);
  if (!messageId || !dateTs) return null;

  const sender = anyMsg.sender;
  const replyToMsgId = toNumber(anyMsg.replyTo?.replyToMsgId ?? anyMsg.replyToMsgId);
  const editDateTs = toNumber(anyMsg.editDate);
  const dateIso = isoFromUnixSeconds(dateTs) ?? new Date(dateTs * 1000).toISOString();

  return {
    chatId: chat.chatId,
    messageId,
    firstJobId: jobId,
    lastJobId: jobId,
    dateTs,
    dateIso,
    editDateTs,
    senderId: toIdString(anyMsg.senderId),
    senderUsername: sender?.username ?? null,
    senderName: getSenderName(sender),
    messageText: typeof anyMsg.message === "string" ? anyMsg.message : null,
    rawJson: safeJsonStringify(buildRawMessageSnapshot(msg)),
    mediaType: inferMediaType(msg),
    replyToMsgId,
    groupedId: toIdString(anyMsg.groupedId),
    views: toNumber(anyMsg.views),
    forwards: toNumber(anyMsg.forwards),
    isOut: Boolean(anyMsg.out),
    savedAt: new Date().toISOString(),
  };
}

