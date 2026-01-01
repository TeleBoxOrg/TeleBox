import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { SudoDB } from "@utils/sudoDB";
import { sleep } from "telegram/Helpers";
import { dealCommandPluginWithMessage, getCommandFromMessage, getPrefixes } from "@utils/pluginManager";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

// 获取主前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 环境变量中的sudo前缀
const envPrefixes = process.env.TB_SUDO_PREFIX?.split(/\s+/g).filter((p) => p.length > 0) || [];

// sudo用户和对话缓存
let sudoCache = { ids: [] as number[], cids: [] as number[], ts: 0 };
const SUDO_CACHE_TTL = 10_000; // 10秒

function withSudoDB<T>(fn: (db: SudoDB) => T): T {
  const db = new SudoDB();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function refreshSudoCache() {
  sudoCache.ids = withSudoDB((db) => db.ls().map((u) => u.uid));
  sudoCache.cids = withSudoDB((db) => db.lsChats().map((u) => u.id));
  sudoCache.ts = Date.now();
}

function getSudoIds() {
  if (Date.now() - sudoCache.ts > SUDO_CACHE_TTL) refreshSudoCache();
  return sudoCache.ids;
}

function getSudoCids() {
  if (Date.now() - sudoCache.ts > SUDO_CACHE_TTL) refreshSudoCache();
  return sudoCache.cids;
}

function extractId(from: any): number | null {
  const raw = from?.chatId || from?.channelId || from?.userId;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function buildDisplay(id: number, entity: any, isUser: boolean, mention?: boolean) {
  const parts: string[] = [];
  if (entity?.title) parts.push(entity.title);
  if (entity?.firstName) parts.push(entity.firstName);
  if (entity?.lastName) parts.push(entity.lastName);
  if (entity?.username) {
    parts.push(mention ? `@${entity.username}` : `<code>@${entity.username}</code>`);
  }
  parts.push(
    isUser
      ? `<a href="tg://user?id=${id}">${id}</a>`
      : `<a href="https://t.me/c/${id}">${id}</a>`
  );
  return parts.join(" ").trim();
}

async function handleAddDel(msg: Api.Message, target: string, action: "add" | "del") {
  let entity: any, uid: any, display: any;
  
  if (target) {
    try {
      entity = await msg.client?.getEntity(target);
      uid = entity?.id;
      if (!uid) {
        await msg.edit({ text: "❌ 无法获取用户ID", parseMode: "html" });
        return;
      }
      uid = Number(uid);
      display = buildDisplay(uid, entity, entity instanceof Api.User);
    } catch {
      await msg.edit({ text: "❌ 无法获取用户信息", parseMode: "html" });
      return;
    }
  } else {
    if (!msg.isReply) {
      await msg.edit({ text: "❌ 请回复目标用户的消息或提供 uid/@用户名", parseMode: "html" });
      return;
    }
    const reply = await msg.getReplyMessage();
    if (!reply) {
      await msg.edit({ text: "❌ 无法获取回复消息", parseMode: "html" });
      return;
    }
    uid = extractId(reply.fromId as any);
    if (!uid) {
      await msg.edit({ text: "❌ 无法获取用户ID", parseMode: "html" });
      return;
    }
    try {
      entity = await msg.client?.getEntity(uid);
    } catch {
      // ignore
    }
    display = buildDisplay(uid, entity, !!(reply.fromId as any)?.userId);
  }

  withSudoDB((db) => {
    if (action === "add") db.add(uid, display);
    else db.del(uid);
  });
  sudoCache.ts = 0; // 失效缓存

  await msg.edit({
    text: `${action === "add" ? "✅ 已添加" : "✅ 已删除"}：${display}`,
    parseMode: "html"
  });
  await sleep(2000);
  await msg.delete();
}

async function handleList(msg: Api.Message) {
  const users = withSudoDB((db) => db.ls());
  if (users.length === 0) {
    await msg.edit({ text: "📋 当前没有任何sudo用户", parseMode: "html" });
    return;
  }
  await msg.edit({
    text: `👥 <b>sudo用户列表：</b>\n${users.map((u) => `• ${u.username}`).join("\n")}`,
    parseMode: "html"
  });
}

async function handleChatAddDel(msg: Api.Message, target: any, action: "add" | "del") {
  let entity: any, cid: any, display: any;
  
  if (target) {
    try {
      entity = await msg.client?.getEntity(target);
      cid = entity?.id;
      if (!cid) {
        await msg.edit({ text: "❌ 无法获取对话ID", parseMode: "html" });
        return;
      }
      cid = Number(cid);
      display = buildDisplay(cid, entity, entity instanceof Api.User);
    } catch {
      await msg.edit({ text: "❌ 无法获取对话信息", parseMode: "html" });
      return;
    }
  } else {
    cid = extractId(msg.peerId as any);
    if (!cid) {
      await msg.edit({ text: "❌ 无法获取对话ID", parseMode: "html" });
      return;
    }
    try {
      entity = await msg.client?.getEntity(cid);
    } catch {
      // ignore
    }
    display = buildDisplay(cid, entity, !!(msg.peerId as any)?.userId);
  }

  withSudoDB((db) => {
    if (action === "add") db.addChat(cid, display);
    else db.delChat(cid);
  });
  sudoCache.ts = 0; // 失效缓存

  await msg.edit({
    text: `${action === "add" ? "✅ 已添加" : "✅ 已删除"}：${display}`,
    parseMode: "html"
  });
  await sleep(2000);
  await msg.delete();
}

async function handleChatList(msg: Api.Message) {
  const chats = withSudoDB((db) => db.lsChats());
  if (chats.length === 0) {
    await msg.edit({ text: "⚠️ 未设置对话白名单，所有对话中均可使用", parseMode: "html" });
    return;
  }
  await msg.edit({
    text: `🏠 <b>对话白名单列表：</b>\n${chats.map((c) => `• ${c.name}`).join("\n")}`,
    parseMode: "html"
  });
}

class SudoPlugin extends Plugin {
  name = "sudo";
  description = () => {
    let text = `🔐 Sudo权限管理插件

<b>📝 功能描述：</b>
• 授权其他用户使用bot命令
• 支持用户级和对话级权限控制
• 持久化存储权限配置

<b>🔧 用户管理：</b>
• <code>${mainPrefix}sudo add (uid/@用户名)</code> - 添加sudo用户
• <code>${mainPrefix}sudo del (uid/@用户名)</code> - 删除sudo用户
• <code>${mainPrefix}sudo ls</code> - 列出所有sudo用户

<b>🔧 对话白名单：</b>
• <code>${mainPrefix}sudo chat add (对话ID/@频道名)</code> - 添加白名单对话
• <code>${mainPrefix}sudo chat del (对话ID/@频道名)</code> - 删除白名单对话
• <code>${mainPrefix}sudo chat ls</code> - 查看白名单对话

<b>💡 使用说明：</b>
• 若未设置对话白名单，所有对话中均可使用
• 回复消息时无需提供ID，自动识别回复目标
• 修改实时生效`;

    if (envPrefixes.length > 0) {
      text += `\n\n⚡ 当前Sudo前缀：${envPrefixes.map((p) => `<code>${htmlEscape(p)}</code>`).join(" ")}`;
    }
    return text;
  };

  private dbConnections: SudoDB[] = [];

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sudo: async (msg) => {
      const parts = msg.message.trim().split(/\s+/);
      const command = parts[1];

      // 对话管理
      if (command === "chat") {
        const subCommand = parts[2];
        if (subCommand === "add" || subCommand === "del") {
          await handleChatAddDel(msg, parts[3], subCommand);
          return;
        }
        if (subCommand === "ls" || subCommand === "list") {
          await handleChatList(msg);
          return;
        }
      }

      const target = parts[2];
      if (command === "add" || command === "del") {
        await handleAddDel(msg, target, command);
      } else if (command === "ls" || command === "list") {
        await handleList(msg);
      } else {
        await msg.edit({
          text: `❌ 未知命令 <code>${htmlEscape(command || "")}</code>\n\n${this.description()}`,
          parseMode: "html"
        });
      }
    }
  };

  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined = async (msg) => {
    if (msg.fwdFrom) return;
    
    const uid = extractId(msg.fromId as any);
    const cid = extractId(msg.peerId as any);
    if (!uid || !cid) return;
    
    if (!getSudoIds().includes(uid)) return;
    
    const cids = getSudoCids();
    if (cids.length > 0 && !cids.includes(cid)) return;
    
    const cmd = getCommandFromMessage(msg, envPrefixes);
    if (!cmd) return;

    const sudoMsg = await msg.client?.sendMessage(msg.peerId, {
      message: msg.message,
      replyTo: msg.replyToMsgId,
      formattingEntities: msg.entities,
    });
    
    if (sudoMsg) {
      await dealCommandPluginWithMessage({
        cmd,
        msg: sudoMsg,
        trigger: msg,
        isEdited: false,
      });
    }
  };
  
  async cleanup(): Promise<void> {
    try {
      for (const db of this.dbConnections) {
        try {
          db.close();
        } catch (e) {
          console.error("[SudoPlugin] Error closing database:", e);
        }
      }
      this.dbConnections = [];
      console.log("[SudoPlugin] Cleanup completed");
    } catch (error) {
      console.error("[SudoPlugin] Error during cleanup:", error);
    }
  }
}

export default new SudoPlugin();