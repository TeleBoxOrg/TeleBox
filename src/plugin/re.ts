import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api, client, TelegramClient } from "telegram";
import { RPCError } from "telegram/errors";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
class RePlugin extends Plugin {
  description: string = `复读\n回复一条消息即可复读\n<code>${mainPrefix}re [消息数] [复读次数]</code>`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    re: async (msg, trigger) => {
      const [, ...args] = msg.text.slice(1).split(" ");
      const count = parseInt(args[0]) || 1;
      const repeat = parseInt(args[1]) || 1;

      try {
        if (!msg.isReply) {
          await msg.edit({ text: "你必须回复一条消息才能够进行复读" });
          return;
        }
        let replied = await msg.getReplyMessage();
        const messages = await msg.client?.getMessages(replied?.peerId, {
          offsetId: replied!.id - 1,
          limit: count,
          reverse: true,
        });
        await msg.delete();
        
        // 尝试使用转发方式复读
        let forwardFailed = false;
        for (let i = 0; i < repeat; i++) {
          if (messages && messages.length > 0) {
            try {
              // 使用原始 API 以支持论坛话题 (topMsgId)
              const toPeer = await msg.getInputChat();
              const fromPeer = await replied!.getInputChat();
              const ids = messages.map((m) => m.id);
              const topMsgId =
                replied?.replyTo?.replyToTopId || replied?.replyTo?.replyToMsgId;

              await msg.client?.invoke(
                new Api.messages.ForwardMessages({
                  fromPeer,
                  id: ids,
                  toPeer,
                  // 如果在论坛话题中，指定话题的顶层消息 ID
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
        
        // 如果转发失败（群组禁止转发），使用复制方式
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
      }
      if (trigger) {
        try {
          await trigger.delete();
        } catch (e) {}
      }
    },
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

      // 处理不同类型的消息
      if (message.media) {
        // 有媒体的消息
        sendOptions.file = message.media;
        sendOptions.message = message.message || "";
        
        // 复制消息格式（加粗、斜体等）
        if (message.entities && message.entities.length > 0) {
          sendOptions.formattingEntities = message.entities;
        }
        
        await client.sendFile(peerId, sendOptions);
      } else if (message.message) {
        // 纯文本消息
        sendOptions.message = message.message;
        
        // 复制消息格式
        if (message.entities && message.entities.length > 0) {
          sendOptions.formattingEntities = message.entities;
        }
        
        await client.sendMessage(peerId, sendOptions);
      }
    } catch (error) {
      console.error("复制消息失败:", error);
      throw error;
    }
  }
}

const plugin = new RePlugin();

export default plugin;
