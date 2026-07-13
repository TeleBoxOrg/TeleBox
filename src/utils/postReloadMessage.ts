/**
 * Post-reload / post-blocking-operation message helpers.
 *
 * After reloadRuntime() or long blocking work (npm install), message objects
 * hold a stale TelegramClient. Always snapshot peerId+msgId first, then use
 * a fresh client from getGlobalClient().
 */

import type { Api } from "teleproto";
import { getGlobalClient } from "./runtimeAccess";

export type MessageEditOptions = {
  parseMode?: string;
  linkPreview?: boolean;
};

/**
 * Edit-or-send a status message on the *current* client (pre-reload only).
 */
export async function sendOrEditMessage(
  msg: Api.Message,
  text: string,
  options?: MessageEditOptions
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
  }
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
        opts: Record<string, unknown>
      ) => Promise<unknown>;
    };
    await freshClient.editMessage(targetPeerId, {
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
 * Delete a message by id with exponential backoff using a fresh client.
 * Use after blocking ops that may invalidate msg._client.
 */
export async function deleteStatusMessage(
  peerId: unknown,
  msgId: number,
  delays: number[] = [0, 2000, 4000, 8000]
): Promise<void> {
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const freshClient = (await getGlobalClient()) as {
        deleteMessages: (
          peer: unknown,
          ids: number[],
          opts?: { revoke?: boolean }
        ) => Promise<unknown>;
      };
      await freshClient.deleteMessages(peerId, [msgId], { revoke: true });
      console.log(`[MSG] status message deleted (attempt ${attempt + 1})`);
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[MSG] delete status message failed (attempt ${attempt + 1}):`,
        message
      );
    }
  }
  console.error("[MSG] status message delete exhausted retries");
}
