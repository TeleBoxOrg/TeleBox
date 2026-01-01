import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { SureDB } from "@utils/sureDB";
import { sleep } from "telegram/Helpers";
import { dealCommandPluginWithMessage, getCommandFromMessage } from "@utils/pluginManager";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

// Sure用户、对话和消息缓存
let sureCache = { ids: [] as number[], cids: [] as number[], msgs: [] as any[], ts: 0 };
const SURE_CACHE_TTL = 10_000; // 10秒

function withSureDB<T>(fn: (db: SureDB) => T): T {
  const db = new SureDB();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function refreshSureCache() {
  sureCache.ids = withSureDB((db) => db.ls().map((u) => u.uid));
  sureCache.cids = withSureDB((db) => db.lsChats().map((u) => u.id));
  sureCache.msgs = withSureDB((db) => db.lsMsgs());
  sureCache.ts = Date.now();
}

function getSureIds() {
  if (Date.now() - sureCache.ts > SURE_CACHE_TTL) refreshSureCache();
  return sureCache.ids;
}

function getSureCids() {
  if (Date.now() - sureCache.ts > SURE_CACHE_TTL) refreshSureCache();
  return sureCache.cids;
}

function getSureMsgs() {
  if (Date.now() - sureCache.ts > SURE_CACHE_TTL) refreshSureCache();
  return sureCache.msgs;
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

  withSureDB((db) => {
    if (action === "add") db.add(uid, display);
    else db.del(uid);
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: `${action === "add" ? "✅ 已添加" : "✅ 已删除"}：${display}`,
    parseMode: "html"
  });
  await msg.deleteWithDelay(5000);
}

async function handleList(msg: Api.Message) {
  const users = withSureDB((db) => db.ls());
  if (users.length === 0) {
    await msg.edit({ text: "📋 当前没有任何用户", parseMode: "html" });
    return;
  }
  await msg.edit({
    text: `👥 <b>用户列表：</b>\n${users.map((u) => `• ${u.username}`).join("\n")}`,
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
    display = buildDisplay(cid, entity, !(msg.peerId as any)?.userId);
  }

  withSureDB((db) => {
    if (action === "add") db.addChat(cid, display);
    else db.delChat(cid);
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: `${action === "add" ? "✅ 已添加" : "✅ 已删除"}：${display}`,
    parseMode: "html"
  });
  await msg.deleteWithDelay(5000);
}

async function handleChatList(msg: Api.Message) {
  const chats = withSureDB((db) => db.lsChats());
  if (chats.length === 0) {
    await msg.edit({ text: "⚠️ 未设置对话白名单，所有对话中均可使用", parseMode: "html" });
    return;
  }
  await msg.edit({
    text: `🏠 <b>对话白名单列表：</b>\n${chats.map((c) => `• ${c.name}`).join("\n")}`,
    parseMode: "html"
  });
}

async function handleMsgAddDel(msg: Api.Message, input: any, action: "add" | "del", id?: string) {
  let raw: string | undefined;
  withSureDB((db) => {
    if (action === "add") {
      if (id) {
        raw = db.lsMsgs().find((m) => m.id === Number(id))?.msg;
        if (!raw) throw new Error(`找不到ID为${id}的消息`);
        db.addMsg(raw, input);
      } else {
        db.addMsg(input);
      }
    } else {
      db.delMsg(input);
    }
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: raw && !input
      ? `✅ 已清除 <code>${htmlEscape(raw)}</code> 的重定向`
      : `✅ ${action === "add" ? "已添加" : "已删除"}：<code>${htmlEscape(raw ? `${raw} → ${input}` : input)}</code>`,
    parseMode: "html"
  });
  await msg.deleteWithDelay(5000);
}

async function handleMsgList(msg: Api.Message) {
  const msgs = withSureDB((db) => db.lsMsgs());
  if (msgs.length === 0) {
    await msg.edit({ text: "⚠️ 未设置消息白名单，需设置消息白名单方可使用", parseMode: "html" });
    return;
  }
  await msg.edit({
    text: `📝 <b>消息白名单列表：</b>\n${msgs
      .map((m) => `• <code>${m.id}</code>：<code>${htmlEscape(m.msg)}</code>${m.redirect ? ` → <code>${htmlEscape(m.redirect)}</code>` : ""}`)
      .join("\n")}`,
    parseMode: "html"
  });
}

class SurePlugin extends Plugin {
  name = "sure";
  description = `✅ 高级权限管理插件（支持消息重定向）

<b>📝 功能描述：</b>
• 授权用户使用bot身份发送消息
• 支持消息内容重定向（类似alias）
• 支持命令级授权和对话级白名单
• 持久化存储配置

<b>🔧 用户管理：</b>
• <code>${mainPrefix}sure add (uid/@用户名)</code> - 添加用户
• <code>${mainPrefix}sure del (uid/@用户名)</code> - 删除用户
• <code>${mainPrefix}sure ls</code> - 列出用户

<b>🔧 对话白名单：</b>
• <code>${mainPrefix}sure chat add (对话ID/@频道名)</code> - 添加对话
• <code>${mainPrefix}sure chat del (对话ID/@频道名)</code> - 删除对话
• <code>${mainPrefix}sure chat ls</code> - 查看对话

<b>🔧 消息重定向：</b>
• <code>${mainPrefix}sure msg add &lt;消息内容&gt;</code> - 添加允许的命令/消息
• <code>${mainPrefix}sure msg del &lt;ID&gt;</code> - 删除消息规则
• <code>${mainPrefix}sure msg redirect &lt;ID&gt; &lt;重定向内容&gt;</code> - 设置重定向
• <code>${mainPrefix}sure msg ls</code> - 查看消息规则

<b>💡 高级用法：</b>
使用 <code>_command:/sb</code> 格式可匹配<code>/sb uid</code>变体`;

  private dbConnections: SureDB[] = [];

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sure: async (msg) => {
      const parts = msg.message.trim().split(/\s+/);
      const command = parts[1];

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

      if (command === "msg") {
        const subCommand = parts[2];
        if ((subCommand === "add" || subCommand === "del") && parts[3]) {
          if (subCommand === "del" && (!parts[3] || isNaN(Number(parts[3])))) {
            await msg.edit({ text: "❌ 请提供正确的消息ID", parseMode: "html" });
            return;
          }
          const subCommandTxt = ` ${subCommand} `;
          const input = msg.message.substring(msg.message.indexOf(subCommandTxt) + subCommandTxt.length);
          if (input) {
            await handleMsgAddDel(msg, input, subCommand);
          }
          return;
        }
        if (subCommand === "redirect") {
          const id = parts[3];
          if (!id || isNaN(Number(id))) {
            await msg.edit({ text: "❌ 请提供正确的消息ID", parseMode: "html" });
            return;
          }
          const subCommandTxt = ` ${id} `;
          const input = parts[4] ? msg.message.substring(msg.message.indexOf(subCommandTxt) + subCommandTxt.length) : "";
          if (id) await handleMsgAddDel(msg, input, "add", id);
          return;
        }
        if (subCommand === "ls" || subCommand === "list") {
          await handleMsgList(msg);
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
          text: `❌ 未知命令 <code>${htmlEscape(command || "")}</code>\n\n${this.description}`,
          parseMode: "html"
        });
      }
    }
  };

  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined = async (msg) => {
    if (msg.fwdFrom) return;
    
    const uid = extractId(msg.fromId as any);
    const cid = extractId(msg.peerId as any);
    if (!uid || !cid || !getSureIds().includes(uid)) return;
    
    const cids = getSureCids();
    if (cids.length > 0 && !cids.includes(cid)) return;

    const msgs = getSureMsgs();
    let replacedMsg = null;
    const matchedMsg = msgs.find((m) => {
      if (m.msg.startsWith("_command:")) {
        const prefix = m.msg.replace("_command:", "");
        const isStartsWith = msg.message.startsWith(prefix);
        const suffix = msg.message.replace(prefix, "");
        const matched = isStartsWith && (!suffix || suffix.startsWith(" "));
        if (matched && m.redirect) {
          replacedMsg = msg.message.replace(prefix, m.redirect);
        }
        return matched;
      }
      return m.msg === msg.message;
    });
    
    if (!matchedMsg) return;

    const message = replacedMsg || matchedMsg.redirect || msg.message;
    const cmd = await getCommandFromMessage(message);
    
    const sudoMsg = await msg.client?.sendMessage(msg.peerId, {
      message,
      replyTo: msg.replyToMsgId,
      formattingEntities: msg.entities,
    });
    
    if (cmd && sudoMsg) {
      await dealCommandPluginWithMessage({
        cmd,
        msg: sudoMsg,
        trigger: msg,
        isEdited: false,
      });
    }
    
    await msg.deleteWithDelay(5000);
  };
  
  async cleanup(): Promise<void> {
    try {
      for (const timer of this.activeTimers) {
        clearTimeout(timer);
      }
      this.activeTimers = [];
      
      for (const db of this.dbConnections) {
        try {
          db.close();
        } catch (e) {
          console.error("[SurePlugin] Error closing database:", e);
        }
      }
      this.dbConnections = [];
      
      console.log("[SurePlugin] Cleanup completed");
    } catch (error) {
      console.error("[SurePlugin] Error during cleanup:", error);
    }
  }
}

export default new SurePlugin();