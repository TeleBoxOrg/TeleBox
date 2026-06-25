import { TelegramClient } from "teleproto";
import { EntityLike } from "teleproto/define";
import { NewMessage, NewMessageEvent } from "teleproto/events";
import { Api } from "teleproto/tl";
import {
  getCurrentGeneration,
  tryGetCurrentGenerationContext,
} from "./runtimeManager";
import type { GenerationContext } from "./generationContext";

type ConversationCancellationOptions = {
  signal?: AbortSignal;
  lifecycle?: GenerationContext;
};

type ConversationOptions = ConversationCancellationOptions & {
  timeout?: number;
};

type ResolvedConversationOptions = Required<Pick<ConversationOptions, "timeout">> & {
  lifecycle?: GenerationContext;
  signals: AbortSignal[];
};

function getAbortedSignal(signals: AbortSignal[]): AbortSignal | undefined {
  return signals.find((signal) => signal.aborted);
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Conversation wait aborted");
}

function throwIfAborted(signals: AbortSignal[]): void {
  const signal = getAbortedSignal(signals);
  if (signal) {
    throw abortError(signal.reason);
  }
}

function resolveConversationOptions(
  timeoutOrOptions?: number | ConversationOptions
): ResolvedConversationOptions {
  const options = typeof timeoutOrOptions === "number"
    ? { timeout: timeoutOrOptions }
    : timeoutOrOptions ?? {};
  const lifecycle = options.lifecycle ?? tryGetCurrentGenerationContext() ?? undefined;
  return {
    timeout: options.timeout ?? 10000,
    lifecycle,
    signals: [options.signal, lifecycle?.signal].filter((signal): signal is AbortSignal => Boolean(signal)),
  };
}

function getPeerUserId(peerId: unknown): { equals(id: unknown): boolean } | undefined {
  if (typeof peerId !== "object" || peerId === null || !("userId" in peerId)) {
    return undefined;
  }
  const userId = peerId.userId;
  if (
    typeof userId === "object" &&
    userId !== null &&
    "equals" in userId &&
    typeof userId.equals === "function"
  ) {
    return userId as { equals(id: unknown): boolean };
  }
  return undefined;
}

function getEntityId(entity: unknown): unknown {
  if (typeof entity === "object" && entity !== null && "id" in entity) {
    return entity.id;
  }
  return undefined;
}

/**
 * 一次性等待消息
 * 自动 add/remove listener，支持超时
 */
async function waitForMessage(
  client: TelegramClient,
  peer: EntityLike,
  timeoutOrOptions?: number | ConversationOptions
): Promise<NewMessageEvent> {
  const options = resolveConversationOptions(timeoutOrOptions);
  throwIfAborted(options.signals);
  const generation = options.lifecycle?.generation ?? getCurrentGeneration();
  const eventBuilder = new NewMessage({});

  const task = new Promise<NewMessageEvent>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeListener: (() => void | Promise<void>) | undefined;

    const cleanup = (): void => {
      options.signals.forEach((signal) => signal.removeEventListener("abort", onAbort));
      if (removeListener) {
        void Promise.resolve(removeListener()).catch((error) => {
          console.error("[CONVERSATION] Failed to remove message listener:", error);
        });
        removeListener = undefined;
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onAbort = (): void => {
      settle(() => reject(abortError(getAbortedSignal(options.signals)?.reason)));
    };

    void (async () => {
      try {
        const entity = await client.getEntity(peer);
        throwIfAborted(options.signals);
        const peerId = getEntityId(entity);

        const listener = (event: NewMessageEvent) => {
          if (settled) return;
          if (generation !== getCurrentGeneration() || getAbortedSignal(options.signals)) {
            onAbort();
            return;
          }
          const userId = getPeerUserId(event.message?.peerId);
          if (userId?.equals(peerId)) {
            settle(() => resolve(event));
          }
        };

        client.addEventHandler(listener, eventBuilder);
        const disposeListener = (): void => client.removeEventHandler(listener, eventBuilder);
        removeListener = options.lifecycle
          ? options.lifecycle.trackDisposable(disposeListener, {
            label: "conversation-wait-message:handler",
            kind: "handler",
          })
          : disposeListener;

        options.signals.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
        timer = options.lifecycle
          ? options.lifecycle.setTimeout(() => {
            settle(() => reject(new Error("等待 Bot 回复超时")));
          }, options.timeout, { label: "conversation-wait-message:timeout" })
          : setTimeout(() => {
            settle(() => reject(new Error("等待 Bot 回复超时")));
          }, options.timeout);

        if (getAbortedSignal(options.signals)) {
          onAbort();
        }
      } catch (error) {
        settle(() => reject(error));
      }
    })();
  });

  return options.lifecycle
    ? options.lifecycle.trackTask(task, { label: "conversation-wait-message", kind: "conversation" })
    : task;
}

/**
 * Conversation 类
 */
class Conversation {
  private client: TelegramClient;
  private peer: EntityLike;
  private options: ConversationCancellationOptions;

  constructor(client: TelegramClient, peer: EntityLike, options?: ConversationCancellationOptions) {
    this.client = client;
    this.peer = peer;
    this.options = options ?? {};
  }

  /** 发送文本消息 */
  async send(message: string): Promise<void> {
    throwIfAborted(resolveConversationOptions(this.options).signals);
    await this.client.sendMessage(this.peer, { message });
  }

  /** 等待 Bot 回复 */
  async getResponse(timeout?: number | ConversationOptions): Promise<Api.Message> {
    const options = typeof timeout === "number"
      ? { ...this.options, timeout }
      : { ...this.options, ...timeout };
    return (await waitForMessage(this.client, this.peer, options)).message;
  }

  /** 标记信息为已读取 */
  async markAsRead(): Promise<void> {
    throwIfAborted(resolveConversationOptions(this.options).signals);
    await this.client.markAsRead(this.peer);
  }

  /** 点击 InlineKeyboard 按钮 */
  async clickButton(
    message: Api.Message,
    rowIndex: number,
    colIndex: number
  ): Promise<void> {
    if (
      !message.replyMarkup ||
      !(message.replyMarkup instanceof Api.ReplyInlineMarkup)
    ) {
      throw new Error("消息没有 InlineKeyboard 按钮");
    }

    const rows = message.replyMarkup.rows;
    if (rowIndex >= rows.length || colIndex >= rows[rowIndex].buttons.length) {
      throw new Error("按钮索引超出范围");
    }

    const button = rows[rowIndex].buttons[colIndex];
    await this.client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: this.peer,
        msgId: message.id,
        data: (button as Api.KeyboardButtonCallback).data,
      })
    );
  }

  async close(): Promise<void> {
    // 如果有需要清理的逻辑可以加在这里
  }
}

type ConversationCallback = (conv: Conversation) => Promise<void>;

function getConversationCancellationOptions(
  options?: ConversationCancellationOptions | ConversationCallback
): ConversationCancellationOptions | undefined {
  return typeof options === "function" ? undefined : options;
}

async function conversation(
  client?: TelegramClient,
  peer?: EntityLike,
  callbackOrOptions?: ConversationCallback | ConversationCancellationOptions,
  optionsOrCallback?: ConversationCancellationOptions | ConversationCallback
): Promise<void> {
  if (!client || !peer) {
    throw new Error("client 和 peer 参数不能为空");
  }

  const callback = typeof callbackOrOptions === "function"
    ? callbackOrOptions
    : typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : undefined;
  const options = typeof callbackOrOptions === "function"
    ? optionsOrCallback
    : callbackOrOptions;

  const conv = new Conversation(client, peer, getConversationCancellationOptions(options));
  try {
    if (callback) {
      await callback(conv);
    }
  } finally {
    await conv.close();
  }
}

export { conversation };
