import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { Api, TelegramClient } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { CustomFile } from "telegram/client/uploads";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

class DebugPlugin extends Plugin {
  name = "debug";
  description = `🔍 Telegram 实体调试工具

<b>📝 功能描述：</b>
• 获取用户、群组、频道的详细信息
• 查看消息原始数据结构
• 解析消息链接和用户名
• 支持转发消息测试

<b>🔧 使用方法：</b>
• <code>${mainPrefix}id</code> - 查看当前对话信息
• <code>${mainPrefix}id 回复消息</code> - 查看回复消息信息
• <code>${mainPrefix}id @用户名</code> - 查看用户信息
• <code>${mainPrefix}id 群组ID</code> - 查看群组信息
• <code>${mainPrefix}entity</code> - 获取 entity 对象
• <code>${mainPrefix}msg</code> - 获取 message 对象
• <code>${mainPrefix}echo</code> - 原样回复消息

<b>💡 示例：</b>
• <code>${mainPrefix}id https://t.me/c/123456/789</code> - 解析私有消息链接
• <code>${mainPrefix}id @username</code> - 查看公开用户名信息`;

  private eventListenerIds: string[] = [];

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    id: async (msg) => {
      const client = await getGlobalClient();
      let targetInfo = "";

      try {
        const [cmd, ...args] = msg.message.trim().split(/\s+/);
        const messageLink = args.join(" ");

        if (messageLink) {
          let parseResult: ParseResult | null = null;

          if (messageLink.includes("t.me/")) {
            parseResult = await parseTelegramLink(client, messageLink);
          } else if (/^-?\d+$/.test(messageLink)) {
            const parsedInfo = await parseGroupId(client, messageLink);
            targetInfo = parsedInfo;
          } else {
            try {
              const username = messageLink.startsWith("@") ? messageLink : `@${messageLink}`;
              const entity = await client.getEntity(username);
              parseResult = { type: "entity", data: entity, info: `解析用户名成功 - ${username}` };
            } catch (error: any) {
              parseResult = { type: "entity", data: null, info: `解析用户名失败：${error.message}` };
            }
          }

          if (!/^-?\d+$/.test(messageLink)) {
            if (parseResult && parseResult.data) {
              if (parseResult.type === "message") {
                const parsedMsg = parseResult.data as Api.Message;
                targetInfo += `🔗 ${parseResult.info}\n\n`;
                if (parsedMsg.senderId) {
                  targetInfo += await formatUserInfo(client, parsedMsg.senderId, "消息发送者", true);
                  targetInfo += "\n";
                }
                targetInfo += await formatMessageInfo(parsedMsg);
                targetInfo += "\n";
                targetInfo += await formatChatInfo(client, parsedMsg);
              } else if (parseResult.type === "entity") {
                const entity = parseResult.data;
                targetInfo += `🔗 ${parseResult.info}\n\n`;
                targetInfo += await formatEntityInfo(entity);
              }
            } else {
              targetInfo = `❌ ${parseResult?.info || "无法解析链接或用户名"}`;
            }
          }
        } else {
          if (msg.replyTo) {
            const repliedMsg = await msg.getReplyMessage();
            if (repliedMsg?.senderId) {
              targetInfo += await formatUserInfo(client, repliedMsg.senderId, "回复消息发送者", true);
              targetInfo += "\n";
            }
          }

          targetInfo += await formatMessageInfo(msg);
          targetInfo += "\n";

          if (!msg.replyTo) {
            targetInfo += await formatUserInfo(client, (await client.getMe()).id, "自己", false);
            targetInfo += "\n";
          }

          targetInfo += await formatChatInfo(client, msg);
        }

        await msg.edit({ text: targetInfo, parseMode: "html" });
      } catch (error: any) {
        await msg.edit({ text: `获取信息时出错：<code>${htmlEscape(error.message)}</code>`, parseMode: "html" });
      }
    },

    entity: async (msg, trigger) => {
      const [cmd, ...args] = msg.message.trim().split(/\s+/);
      const input = args.join("");
      const reply = await msg.getReplyMessage();
      const entity = await msg.client?.getEntity(
        input || reply?.senderId || msg.peerId
      );

      const txt = JSON.stringify(entity, null, 2);
      console.log(txt);

      try {
        await msg.edit({
          text: `<blockquote expandable>${txt}</blockquote>`,
          parseMode: "html"
        });
      } catch (error: any) {
        if (error.message?.includes("MESSAGE_TOO_LONG") || error.message?.includes("too long")) {
          const buffer = Buffer.from(txt, "utf-8");
          const dir = createDirectoryInTemp("debug");
          const filename = `entity_${entity?.id}.json`;
          const filePath = path.join(dir, filename);
          fs.writeFileSync(filePath, buffer);
          const size = fs.statSync(filePath).size;
          await (trigger || msg).reply({
            file: new CustomFile(filename, size, filePath)
          });
          fs.unlinkSync(filePath);
        } else {
          throw error;
        }
      }
    },

    msg: async (msg, trigger) => {
      const reply = await msg.getReplyMessage();
      if (!reply) {
        await msg.edit({ text: "请回复一条消息以获取详细信息" });
        return;
      }
      const txt = JSON.stringify(reply, null, 2);
      console.log(txt);

      try {
        await msg.edit({
          text: `<blockquote expandable>${txt}</blockquote>`,
          parseMode: "html"
        });
      } catch (error: any) {
        if (error.message?.includes("MESSAGE_TOO_LONG") || error.message?.includes("too long")) {
          const buffer = Buffer.from(txt, "utf-8");
          const dir = createDirectoryInTemp("debug");
          const filename = `msg_${reply.id}.json`;
          const filePath = path.join(dir, filename);
          fs.writeFileSync(filePath, buffer);
          const size = fs.statSync(filePath).size;
          await (trigger || msg).reply({
            file: new CustomFile(filename, size, filePath)
          });
          fs.unlinkSync(filePath);
        } else {
          throw error;
        }
      }
    },

    echo: async (msg, trigger) => {
      const reply = await msg.getReplyMessage();
      if (!reply) {
        await msg.edit({ text: "请回复一条消息以尝试原样发出" });
        return;
      }
      const txt = JSON.stringify(reply, null, 2);
      console.log(txt);

      const toInputMedia = (media: Api.TypeMessageMedia): Api.TypeInputMedia | undefined => {
        try {
          if (media instanceof Api.MessageMediaPhoto && media.photo && media.photo instanceof Api.Photo) {
            return new Api.InputMediaPhoto({
              id: new Api.InputPhoto({
                id: media.photo.id,
                accessHash: media.photo.accessHash,
                fileReference: media.photo.fileReference
              }),
              ...(media.spoiler ? { spoiler: true } : {}),
              ...(media.ttlSeconds ? { ttlSeconds: media.ttlSeconds } : {})
            });
          }
          if (media instanceof Api.MessageMediaDocument && media.document && media.document instanceof Api.Document) {
            return new Api.InputMediaDocument({
              id: new Api.InputDocument({
                id: media.document.id,
                accessHash: media.document.accessHash,
                fileReference: media.document.fileReference
              }),
              ...(media.spoiler ? { spoiler: true } : {}),
              ...(media.ttlSeconds ? { ttlSeconds: media.ttlSeconds } : {})
            });
          }
        } catch (e) {
          console.warn("[debug.echo] 构造 InputMedia 失败", e);
        }
        return undefined;
      };

      const inputMedia = reply.media ? toInputMedia(reply.media) : undefined;

      if (inputMedia) {
        await msg.client?.invoke(
          new Api.messages.SendMedia({
            peer: reply.chatId,
            message: reply.message || "",
            media: inputMedia,
            entities: reply.entities,
            ...(reply.replyTo && {
              replyTo: new Api.InputReplyToMessage({
                replyToMsgId: reply.replyTo.replyToMsgId!,
                quoteText: reply.replyTo.quoteText,
                quoteEntities: reply.replyTo.quoteEntities,
                quoteOffset: reply.replyTo.quoteOffset,
                topMsgId: reply.replyTo.replyToTopId
              })
            })
          })
        );
      } else {
        await msg.client?.invoke(
          new Api.messages.SendMessage({
            peer: reply.chatId,
            message: reply.message,
            entities: reply.entities,
            ...(reply.replyTo && {
              replyTo: new Api.InputReplyToMessage({
                replyToMsgId: reply.replyTo.replyToMsgId!,
                quoteText: reply.replyTo.quoteText,
                quoteEntities: reply.replyTo.quoteEntities,
                quoteOffset: reply.replyTo.quoteOffset,
                topMsgId: reply.replyTo.replyToTopId
              })
            })
          })
        );
      }
      await msg.delete();
    }
  };

  async cleanup(): Promise<void> {
    try {
      // 清理事件监听器
      const client = await getGlobalClient();
      for (const listenerId of this.eventListenerIds) {
        client.removeListener(listenerId, () => {});
      }
      this.eventListenerIds = [];
      console.log("[DebugPlugin] Cleanup completed");
    } catch (error) {
      console.error("[DebugPlugin] Error during cleanup:", error);
    }
  }
}

// 辅助类型和函数
interface ParseResult {
  type: "message" | "entity";
  data: Api.Message | any;
  info?: string;
}

async function parseTelegramLink(client: TelegramClient, link: string): Promise<ParseResult | null> {
  try {
    const cleanLink = link.trim();
    const messageRegex = /https?:\/\/t\.me\/(?:c\/)?([^\/]+)\/(\d+)/;
    const messageMatch = cleanLink.match(messageRegex);

    if (messageMatch) {
      const [, chatIdentifier, messageId] = messageMatch;
      const chatId = cleanLink.includes("/c/") ? `-100${chatIdentifier}` : `@${chatIdentifier}`;
      const messages = await client.getMessages(chatId, { ids: [parseInt(messageId)] });
      
      if (messages.length > 0) {
        return {
          type: "message",
          data: messages[0],
          info: `解析消息链接成功 - Chat: ${chatId}, Message: ${messageId}`
        };
      }
    }

    const entityRegex = /https?:\/\/t\.me\/([^\/\?#]+)/;
    const entityMatch = cleanLink.match(entityRegex);

    if (entityMatch) {
      const [, identifier] = entityMatch;
      if (identifier.startsWith("joinchat/")) {
        return { type: "entity", data: null, info: `暂不支持 joinchat 链接解析` };
      }
      
      const username = identifier.startsWith("@") ? identifier : `@${identifier}`;
      const entity = await client.getEntity(username);
      return { type: "entity", data: entity, info: `解析实体链接成功 - ${username}` };
    }

    return null;
  } catch (error: any) {
    console.error("解析链接失败:", error);
    return { type: "entity", data: null, info: `解析失败：${error.message}` };
  }
}

async function formatEntityInfo(entity: any): Promise<string> {
  try {
    let info = "";
    if (entity.className === "User") {
      info += `<b>👤 USER</b>\n`;
      const fullName = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || "N/A";
      info += `· 名称：${htmlEscape(fullName)}\n`;
      info += `· 用户名：${entity.username ? `@${entity.username}` : "N/A"}\n`;
      info += `· ID：<code>${entity.id}</code>\n`;
      if (entity.bot) info += `· 类型：Bot\n`;
      if (entity.verified) info += `· 已认证\n`;
      if (entity.premium) info += `· Premium用户\n`;
    } else if (entity.className === "Channel") {
      const isChannel = entity.broadcast;
      info += `<b>📢 ${isChannel ? "CHANNEL" : "SUPERGROUP"}</b>\n`;
      info += `· 标题：${htmlEscape(entity.title)}\n`;
      info += `· 用户名：${entity.username ? `@${entity.username}` : "N/A"}\n`;
      const entityId = entity.id.toString();
      const fullId = entityId.startsWith("-100") ? entityId : `-100${entityId}`;
      info += `· ID：<code>${fullId}</code>\n`;
      if (entity.verified) info += `· 已认证\n`;
      if (entity.participantsCount) info += `· 成员数：${entity.participantsCount}\n`;
    } else if (entity.className === "Chat") {
      info += `<b>👥 GROUP</b>\n`;
      info += `· 标题：${htmlEscape(entity.title)}\n`;
      const groupId = entity.id.toString();
      const fullGroupId = groupId.startsWith("-") ? groupId : `-${groupId}`;
      info += `· ID：<code>${fullGroupId}</code>\n`;
      if (entity.participantsCount) info += `· 成员数：${entity.participantsCount}\n`;
    } else {
      info += `<b>📦 ENTITY</b>\n`;
      info += `· 类型：${entity.className}\n`;
      info += `· ID：<code>${entity.id}</code>\n`;
    }
    return info;
  } catch (error: any) {
    return `❌ 格式化实体信息失败：<code>${htmlEscape(error.message)}</code>`;
  }
}

async function formatMessageInfo(msg: Api.Message): Promise<string> {
  try {
    let info = `<b>💬 MESSAGE</b>\n`;
    if (msg.replyTo?.replyToMsgId) info += `· 回复消息：<code>${msg.replyTo.replyToMsgId}</code>\n`;
    info += `· 消息ID：<code>${msg.id}</code>\n`;
    info += `· 发送者：<code>${msg.senderId || "N/A"}</code>\n`;
    info += `· 对话ID：<code>${msg.chatId || "N/A"}</code>\n`;
    if (msg.date) info += `· 时间：${new Date(msg.date * 1000).toLocaleString("zh-CN")}\n`;

    if (msg.fwdFrom) {
      info += `\n<b>📤 FORWARD INFO</b>\n`;
      if (msg.fwdFrom.fromId) {
        const fromIdStr = msg.fwdFrom.fromId.toString();
        info += `· 原始发送者：<code>${fromIdStr}</code>\n`;
      }
      if (msg.fwdFrom.channelPost) info += `· 原始消息ID：<code>${msg.fwdFrom.channelPost}</code>\n`;
      if (msg.fwdFrom.date) info += `· 转发时间：${new Date(msg.fwdFrom.date * 1000).toLocaleString("zh-CN")}\n`;
      if (msg.fwdFrom.postAuthor) info += `· 发布者：${htmlEscape(msg.fwdFrom.postAuthor)}\n`;
      if (msg.fwdFrom.fromName && !msg.fwdFrom.fromId) info += `· 隐藏用户：${htmlEscape(msg.fwdFrom.fromName)}\n`;
    }

    return info;
  } catch (error: any) {
    return `<b>💬 MESSAGE</b>\n错误：${htmlEscape(error.message)}\n`;
  }
}

async function formatUserInfo(client: TelegramClient, userId: any, title: string = "USER", showCommonGroups: boolean = true): Promise<string> {
  try {
    const user = await client.getEntity(userId);
    let info = `<b>${title}</b>\n`;
    
    if (user.className === "User") {
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "N/A";
      info += `· 名称：${htmlEscape(fullName)}\n`;
      info += `· 用户名：${user.username ? `@${user.username}` : "N/A"}\n`;
      info += `· ID：<code>${user.id}</code>\n`;
      if (user.bot) info += `· 类型：Bot\n`;
      if (user.verified) info += `· 已认证\n`;
      if (user.premium) info += `· Premium用户\n`;
    } else {
      info += `· ID：<code>${user.id}</code>\n`;
      info += `· 类型：${user.className}\n`;
    }
    return info;
  } catch (error: any) {
    return `<b>${title}</b>\n错误：${htmlEscape(error.message)}\n`;
  }
}

async function formatChatInfo(client: TelegramClient, msg: Api.Message): Promise<string> {
  try {
    if (!msg.chatId) return `<b>💬 CHAT</b>\n错误：无对话ID\n`;
    
    const chat = await client.getEntity(msg.chatId);
    let info = "";
    
    if (chat.className === "User") {
      info += await formatUserInfo(client, chat.id, "私聊", false);
    } else if (["Chat", "ChatForbidden"].includes(chat.className)) {
      info += `<b>👥 GROUP</b>\n`;
      info += `· 标题：${htmlEscape(chat.title)}\n`;
      const groupId = chat.id.toString();
      const fullGroupId = groupId.startsWith("-") ? groupId : `-${groupId}`;
      info += `· ID：<code>${fullGroupId}</code>\n`;
      if (chat.participantsCount) info += `· 成员数：${chat.participantsCount}\n`;
    } else if (chat.className === "Channel") {
      const isChannel = chat.broadcast;
      info += `<b>${isChannel ? "📢 CHANNEL" : "👥 SUPERGROUP"}</b>\n`;
      info += `· 标题：${htmlEscape(chat.title)}\n`;
      info += `· 用户名：${chat.username ? `@${chat.username}` : "N/A"}\n`;
      const chatId = chat.id.toString();
      const fullChatId = chatId.startsWith("-100") ? chatId : `-100${chatId}`;
      info += `· ID：<code>${fullChatId}</code>\n`;
      if (chat.verified) info += `· 已认证\n`;
    }
    return info;
  } catch (error: any) {
    return `<b>💬 CHAT</b>\n错误：${htmlEscape(error.message)}\n`;
  }
}

async function parseGroupId(client: TelegramClient, chatId: string): Promise<string> {
  try {
    let info = `🆔 <b>群组ID解析结果</b>\n\n`;
    info += `· 输入ID：<code>${chatId}</code>\n`;
    let entity: any;
    
    try {
      entity = await client.getEntity(chatId);
      info += `· 状态：✅ 访问成功\n\n`;
      info += `<b>📋 群组信息：</b>\n`;
      
      if (entity.className === "Channel") {
        const channel = entity as Api.Channel;
        const isChannel = channel.broadcast;
        info += `· 类型：${isChannel ? "频道" : "超级群组"}\n`;
        info += `· 名称：${htmlEscape(channel.title)}\n`;
        if (channel.username) {
          info += `· 用户名：@${channel.username}\n`;
          info += `· 公开链接：https://t.me/${channel.username}\n`;
        } else {
          info += `· 用户名：无（私有）\n`;
          const numericId = channel.id.toString().replace("-100", "");
          info += `· 私有链接：https://t.me/c/${numericId}/1\n`;
        }
        if (channel.participantsCount) info += `· 成员数：${channel.participantsCount}\n`;
        if (channel.verified) info += `· 已认证：✅\n`;
      } else if (entity.className === "Chat") {
        info += `· 类型：普通群组\n`;
        info += `· 名称：${htmlEscape(entity.title)}\n`;
        info += `· 用户名：无（普通群组无用户名）\n`;
      }
    } catch (error: any) {
      info += `· 状态：❌ 无法访问\n`;
      info += `· 错误：<code>${htmlEscape(error.message)}</code>\n\n`;
      
      if (chatId.startsWith("-100")) {
        const numericId = chatId.replace("-100", "");
        info += `<b>🔗 链接格式：</b>\n`;
        info += `· 私有链接：https://t.me/c/${numericId}/1\n`;
      }
    }

    return info;
  } catch (error: any) {
    return `❌ 解析群组ID时发生错误：<code>${htmlEscape(error.message)}</code>`;
  }
}

export default new DebugPlugin();