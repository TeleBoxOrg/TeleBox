import { TelegramClient } from "teleproto";
import { EntityLike } from "teleproto/define";
import { NewMessage, NewMessageEvent } from "teleproto/events";
import { Api } from "teleproto/tl";

/**
 * 一次性等待消息
 * 自动 add/remove listener，支持超时
 */
async function waitForMessage(
  client: TelegramClient,
  peer: EntityLike,
  timeout = 10000
): Promise<NewMessageEvent> {
  return new Promise<NewMessageEvent>(async (resolve, reject) => {
    const entity = await client.getEntity(peer);
    const peerId = (entity as any).id;

    const listener = (event: NewMessageEvent) => {
      const msg = event.message;
      if ((msg?.peerId as any).userId?.equals(peerId)) {
        client.removeEventHandler(listener, new NewMessage({}));
        resolve(event);
      }
    };

    client.addEventHandler(listener, new NewMessage({}));

    setTimeout(() => {
      client.removeEventHandler(listener, new NewMessage({}));
      reject(new Error("等待 Bot 回复超时"));
    }, timeout);
  });
}

/**
 * Conversation 类
 */
class Conversation {
  private client: TelegramClient;
  private peer: EntityLike;

  constructor(client: TelegramClient, peer: EntityLike) {
    this.client = client;
    this.peer = peer;
  }

  /** 发送文本消息 */
  async send(message: string): Promise<void> {
    await this.client.sendMessage(this.peer, { message });
  }

  /** 等待 Bot 回复 */
  async getResponse(timeout?: number): Promise<Api.Message> {
    return (await waitForMessage(this.client, this.peer, timeout)).message;
  }

  /** 标记信息为已读取 */
  async markAsRead(): Promise<void> {
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

/** 会话封装函数，模拟 Pyrogram conversation */
async function conversation(
  client?: TelegramClient,
  peer?: EntityLike,
  callback?: (conv: Conversation) => Promise<void>
): Promise<void> {
  if (!client || !peer) {
    throw new Error("client 和 peer 参数不能为空");
  }
  const conv = new Conversation(client, peer);
  try {
    if (callback) {
      await callback(conv);
    }
  } finally {
    await conv.close();
  }
}

export { conversation };
