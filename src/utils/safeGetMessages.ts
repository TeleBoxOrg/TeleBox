import { Api } from "teleproto";

function isUndefinedDateCrash(error: any): boolean {
  const message = String(error?.message || error || "");
  return (
    message.includes("Cannot read properties of undefined") &&
    message.includes("reading 'date'")
  );
}

export async function safeGetMessages(
  client: any,
  entity: any,
  params: Record<string, any>,
): Promise<Api.Message[]> {
  try {
    const result = await client.getMessages(entity, params);
    if (Array.isArray(result)) return result as Api.Message[];
    return result ? [result as Api.Message] : [];
  } catch (error) {
    if (isUndefinedDateCrash(error)) {
      return [];
    }
    throw error;
  }
}

export async function safeGetReplyMessage(
  msg?: Api.Message | null,
): Promise<Api.Message | undefined> {
  if (!msg?.replyTo || !msg.client) {
    return undefined;
  }

  const replyToMsgId = (msg as Api.Message & {
    replyTo?: { replyToMsgId?: number };
    replyToMsgId?: number;
  }).replyTo?.replyToMsgId ?? (msg as any).replyToMsgId;

  if (!replyToMsgId) {
    return undefined;
  }

  const peer = msg.inputChat ?? msg.peerId ?? msg.chatId;
  if (!peer) {
    return undefined;
  }

  const [replyMsg] = await safeGetMessages(msg.client, peer, { ids: [replyToMsgId] });
  return replyMsg;
}
