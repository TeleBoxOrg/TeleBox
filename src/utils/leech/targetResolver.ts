import { Api, TelegramClient } from "teleproto";
import { toIdString } from "./json";
import type { LeechChatIdentity } from "./types";

function normalizeTelegramLink(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^https?:\/\/t\.me\/(.+)$/i);
  if (!match) return trimmed;

  const path = match[1].replace(/[?#].*$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "c" && parts[1]) {
    return `-100${parts[1]}`;
  }
  if (parts[0]) {
    return parts[0].startsWith("@") ? parts[0] : `@${parts[0]}`;
  }
  return trimmed;
}

function fullChatId(entity: any): string {
  const raw = toIdString(entity?.id) ?? "unknown";
  if (entity?.className === "Channel") {
    return raw.startsWith("-100") ? raw : `-100${raw.replace(/^-100/, "")}`;
  }
  if (entity?.className === "Chat" || entity?.className === "ChatForbidden") {
    return raw.startsWith("-") ? raw : `-${raw}`;
  }
  return raw;
}

function chatTitle(entity: any): string {
  if (entity?.title) return entity.title;
  const parts = [entity?.firstName, entity?.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (entity?.username) return `@${entity.username}`;
  return entity?.className || "unknown";
}

function chatType(entity: any): string {
  if (entity?.className === "Channel") {
    return entity.broadcast ? "channel" : "supergroup";
  }
  if (entity?.className === "Chat" || entity?.className === "ChatForbidden") {
    return "group";
  }
  if (entity?.className === "User") return entity.bot ? "bot" : "user";
  return entity?.className || "unknown";
}

export async function resolveLeechTarget(params: {
  client: TelegramClient;
  commandMessage: Api.Message;
  targetInput?: string;
}): Promise<{ entity: any; identity: LeechChatIdentity }> {
  const targetInput = params.targetInput?.trim();
  const hereAliases = new Set(["", "here", "current", "this", "当前", "本群"]);

  let entityLike: any;
  if (!targetInput || hereAliases.has(targetInput.toLowerCase())) {
    entityLike = (params.commandMessage as any).chatId ?? params.commandMessage.peerId;
  } else {
    const normalized = normalizeTelegramLink(targetInput);
    entityLike = /^-?\d+$/.test(normalized) || normalized.startsWith("@")
      ? normalized
      : `@${normalized}`;
  }

  const entity = await params.client.getEntity(entityLike);
  const entityAny = entity as any;
  const identity: LeechChatIdentity = {
    input: targetInput || "here",
    chatId: fullChatId(entityAny),
    chatTitle: chatTitle(entityAny),
    chatType: chatType(entityAny),
    username: entityAny?.username ? `@${entityAny.username}` : undefined,
  };

  return { entity, identity };
}
