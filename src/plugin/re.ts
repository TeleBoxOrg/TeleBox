import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import { RPCError } from "telegram/errors";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

class RePlugin extends Plugin {
  name = "re";
  description = `🔁 消息复读插件

<b>📝 功能描述：</b>
• 复读回复的消息
• 支持批量复读多条消息
• 支持重复发送多次
• 自动处理禁止转发的消息（复制发送）

<b>🔧 使用方法：</b>
• <code>${mainPrefix}re</code> - 复读1条消息1次
• <code>${mainPrefix}re [消息数]</code> - 复读N条消息
• <code>${mainPrefix}re [消息数] [复读次数]</code> - 复读N条消息M次

<b>💡 示例：</b>
• <code>${mainPrefix}re</code> - 复读1条消息1次
• <code>${mainPrefix}re 5</code> - 复读5条消息各1次
• <code>${mainPrefix}re 3 2</code> - 复读3条消息各2次

<b>⚠️ 注意事项：</b>
• 必须回复一条消息才能使用
• 在禁止转发的群组会自动使用复制模式
• 频繁使用可能被Telegram限制`;

  private activeTimers: NodeJS.Timeout[] = [];

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    re: async (msg, trigger) => {
      const [, ...args] = msg.text.slice(1).split(" ");
      const count = parseInt(args[0]) || 1;
      const repeat = parseInt(args[1]) || 1;

      try {
        if (!msg.isReply) {
          await msg.edit({ text: "❌ 你必须回复一条消息才能复读", parseMode: "html" });
          return;
        }

        const replied = await msg.getReplyMessage();
        const messages = await msg.client?.getMessages(replied?.peerId, {
          offsetId: replied!.id - 1,
          limit: count,
          reverse: true,
        });

        await msg.delete();
        let forwardFailed = false;

        // 尝试转发方式
        for (let i = 0; i < repeat; i++) {
          if (messages && messages.length > 0) {
            try {
              const toPeer = await msg.getInputChat();
              const fromPeer = await replied!.getInputChat();
              const ids = messages.map((m) => m.id);
              const topMsgId = replied?.replyTo?.replyToTopId || replied?.replyTo?.replyToMsgId;

              await msg.client?.invoke(
                new Api.messages.ForwardMessages({
                  fromPeer,
                  id: ids,
                  toPeer,
                  ...(topMsgId ? { topMsgId } : {}),
                })
              );
            } catch (error) {
              if (error instanceof RPCError && error.errorMessage === "CHAT_FORWARDS_RESTRICTED") {
                forwardFailed = true;
                break;
              } else {
                throw error;
              }
            }
          }
        }

        // 如果转发失败，使用复制方式
        if (forwardFailed && messages && messages.length > 0) {
          for (let i = 0; i < repeat; i++) {
            for (const message of messages) {
              await this.copyMessage(msg.client!, msg.peerId, message, replied?.replyTo?.replyToTopId || replied?.replyTo?.replyToMsgId);
            }
          }
        }
      } catch (error) {
        if (error instanceof RPCError) {
          await msg.client?.sendMessage(msg.peerId, {
            message: error.message || "发生错误，无法复读消息。请稍后再试。",
          });
        } else {
          await msg.client?.sendMessage(msg.peerId, {
            message: "发生未知错误，无法复读消息。请稍后再试。",
          });
        }
      } finally {
        if (trigger) {
          try {
            await trigger.delete();
          } catch (e) {}
        }
      }
    }
  };

  // 复制消息内容并发送（用于禁止转发的群组）
  private async copyMessage(
    client: TelegramClient,
    peerId: any,
    message: Api.Message,
    topMsgId?: number
  ): Promise<void> {
    try {
      const sendOptions: any = {
        ...(topMsgId ? { replyTo: topMsgId } : {}),
      };

      if (message.media) {
        sendOptions.file = message.media;
        sendOptions.message = message.message || "";
        if (message.entities && message.entities.length > 0) {
          sendOptions.formattingEntities = message.entities;
        }
        await client.sendFile(peerId, sendOptions);
      } else if (message.message) {
        sendOptions.message = message.message;
        if (message.entities && message.entities.length > 0) {
          sendOptions.formattingEntities = message.entities;
        }
        await client.sendMessage(peerId, sendOptions);
      }
    } catch (error) {
      console.error("[RePlugin] 复制消息失败:", error);
      throw error;
    }
  }
  
  async cleanup(): Promise<void> {
    try {
      for (const timer of this.activeTimers) {
        clearTimeout(timer);
      }
      this.activeTimers = [];
      console.log("[RePlugin] Cleanup completed");
    } catch (error) {
      console.error("[RePlugin] Error during cleanup:", error);
    }
  }
}

export default new RePlugin();