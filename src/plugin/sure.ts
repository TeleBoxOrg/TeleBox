import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { SureDB } from "@utils/sureDB";
import { sleep } from "teleproto/Helpers";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// 简单缓存 sure 用户 ID，减少频繁 IO
let sureCache = {
  ids: [] as number[],
  cids: [] as number[],
  msgs: [] as any[],
  ts: 0,
};
const SURE_CACHE_TTL = 10_000; // 10s

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

function buildDisplay(
  id: number,
  entity: any,
  isUser: boolean,
  mention?: boolean
) {
  const parts: string[] = [];
  if (entity?.title) parts.push(entity.title);
  if (entity?.firstName) parts.push(entity.firstName);
  if (entity?.lastName) parts.push(entity.lastName);
  if (entity?.username)
    parts.push(
      mention ? `@${entity.username}` : `<code>@${entity.username}</code>`
    );
  parts.push(
    isUser
      ? `<a href="tg://user?id=${id}">${id}</a>`
      : `<a href="https://t.me/c/${id}">${id}</a>`
  );
  return parts.join(" ").trim();
}

async function handleAddDel(
  msg: Api.Message,
  target: string,
  action: "add" | "del"
) {
  let entity: any;
  let uid: any;
  let display: any;
  if (target) {
    try {
      entity = await msg.client?.getEntity(target);
      uid = entity?.id;
      if (!uid) {
        await msg.edit({ text: "无法获取用户 ID" });
        return;
      }
      uid = Number(uid);
      display = buildDisplay(uid, entity, entity instanceof Api.User);
    } catch {
      await msg.edit({ text: "无法获取用户信息" });
      return;
    }
  } else {
    if (!msg.isReply) {
      await msg.edit({ text: "请回复目标用户的消息或带上 uid/@username" });
      return;
    }
    const reply = await msg.getReplyMessage();
    if (!reply) {
      await msg.edit({ text: "无法获取回复消息" });
      return;
    }
    uid = extractId(reply.fromId as any);
    if (!uid) {
      await msg.edit({ text: "无法获取用户 ID" });
      return;
    }
    try {
      entity = await msg.client?.getEntity(uid);
    } catch {
      /* ignore */
    }
    display = buildDisplay(uid, entity, !!(reply.fromId as any)?.userId);
  }

  withSureDB((db) => {
    if (action === "add") db.add(uid, display);
    else db.del(uid);
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: `已${action === "add" ? "添加" : "删除"}: ${display}`,
    parseMode: "html",
  });
  await msg.deleteWithDelay(5000);
}

async function handleList(msg: Api.Message) {
  const users = withSureDB((db) => db.ls());
  if (users.length === 0) {
    await msg.edit({ text: "当前没有任何用户" });
    return;
  }
  await msg.edit({
    text: `当前用户列表：\n${users.map((u) => "- " + u.username).join("\n")}`,
    parseMode: "html",
  });
}
async function handleChatAddDel(
  msg: Api.Message,
  target: any,
  action: "add" | "del"
) {
  let entity: any;
  let cid: any;
  let display: any;
  if (target) {
    try {
      entity = await msg.client?.getEntity(target);
      cid = entity?.id;
      if (!cid) {
        await msg.edit({ text: "无法获取对话 ID" });
        return;
      }
      cid = Number(cid);
      display = buildDisplay(cid, entity, entity instanceof Api.User);
    } catch {
      await msg.edit({ text: "无法获取对话信息" });
      return;
    }
  } else {
    cid = extractId(msg.peerId as any);
    if (!cid) {
      await msg.edit({ text: "无法获取对话 ID" });
      return;
    }
    try {
      entity = await msg.client?.getEntity(cid);
    } catch {
      /* ignore */
    }
    display = buildDisplay(cid, entity, !!(msg.peerId as any)?.userId);
  }

  withSureDB((db) => {
    if (action === "add") db.addChat(cid, display);
    else db.delChat(cid);
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: `已${action === "add" ? "添加" : "删除"}: ${display}`,
    parseMode: "html",
  });
  await msg.deleteWithDelay(5000);
}
async function handleChatList(msg: Api.Message) {
  const chats = withSureDB((db) => db.lsChats());
  if (chats.length === 0) {
    await msg.edit({ text: "⚠️ 未设置对话白名单, 所有对话中均可使用" });
    return;
  }
  await msg.edit({
    text: `对话白名单列表：\n${chats.map((c) => "- " + c.name).join("\n")}`,
    parseMode: "html",
  });
}
async function handleMsgAddDel(
  msg: Api.Message,
  input: any,
  action: "add" | "del",
  id?: string
) {
  let raw;
  withSureDB((db) => {
    if (action === "add") {
      if (id) {
        raw = db.lsMsgs().find((m) => m.id === Number(id))?.msg;
        if (!raw) throw new Error(`找不到 ID 为 ${id} 的消息`);
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
    text:
      raw && !input
        ? ` 已清除 ${raw} 的重定向`
        : `已${action === "add" ? "添加" : "删除"}: <code>${
            raw ? `${raw} -> ${input}` : input
          }</code>`,
    parseMode: "html",
  });
  await msg.deleteWithDelay(5000);
}
async function handleMsgList(msg: Api.Message) {
  const msgs = withSureDB((db) => db.lsMsgs());
  if (msgs.length === 0) {
    await msg.edit({ text: "⚠️ 未设置消息白名单 需设置消息白名单方可使用" });
    return;
  }
  await msg.edit({
    text: `消息白名单列表：\n${msgs
      .map(
        (m) =>
          `<code>${m.id}</code>: <code>${m.msg}</code>${
            m.redirect ? ` -> <code>${m.redirect}</code>` : ""
          }`
      )
      .join("\n")}`,
    parseMode: "html",
  });
}

class surePlugin extends Plugin {
  description: string = `赋予其他用户使用 bot 身份发送消息(支持重定向)的权限\n<code>.sure add (回复目标用户的消息或带上 uid/@username)</code> - 添加用户\n<code>.sure del (回复目标用户的消息或带上 uid/@username)</code> - 删除用户\n<code>.sure ls</code> - 列出所有用户\n\n⚠️ 若未设置对话白名单, 所有对话中均可使用\n<code>.sure chat add (在当前对话中使用 或带上 id/@name)</code> - 添加对话到白名单\n<code>.sure chat del (在当前对话中使用 或带上 id/@name)</code> - 从白名单删除对话\n<code>.sure chat ls/list</code> - 列出对话白名单\n\n⚠️ 需设置消息白名单方可使用\n<code>.sure msg add 消息(使用原始字符串, 即可包含空格)</code> - 添加消息白名单\n⚠️ 若以 <code>_command:</code> 开头, 认为此消息是命令, 即 <code>_command:/sb</code> 可匹配 <code>/sb</code> 和 <code>/sb uid</code>. 若设置了重定向为 <code>/spam</code>, 则会自动变成 <code>/spam</code> 和 <code>/spam uid</code>\n<code>.sure msg redirect ID 重定向消息(使用原始字符串, 即可包含空格)</code> - 使用消息的 ID 为消息设置重定向(设置空即为清除重定向)\n<code>.sure msg del ID</code> - 使用消息的 ID 从白名单删除消息\n<code>.sure msg ls/list</code> - 列出消息白名单\n\n一个典型的使用场景:\n设置 <code>_command:/sb</code> 重定向到 <code>.ban</code>, 然后给普通群成员权限, 他们发送 /sb 时, 会自动调用 <code>.ban</code> 命令`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sure: async (msg) => {
      const parts = msg.message.trim().split(/\s+/);
      let command = parts[1];
      if (command === "chat") {
        let subCommand = parts[2];
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
        let subCommand = parts[2];
        if ((subCommand === "add" || subCommand === "del") && parts[3]) {
          if (subCommand === "del" && (!parts[3] || isNaN(Number(parts[3])))) {
            await msg.edit({ text: "请提供正确的消息 ID" });
            return;
          }
          const subCommandTxt = ` ${subCommand} `;
          const input = msg.message.substring(
            msg.message.indexOf(subCommandTxt) + subCommandTxt.length
          );
          if (input) {
            await handleMsgAddDel(msg, input, subCommand);
          }
          return;
        }
        if (subCommand === "redirect") {
          const id = parts[3];
          if (!id || isNaN(Number(id))) {
            await msg.edit({ text: "请提供正确的消息 ID" });
            return;
          }
          const subCommandTxt = ` ${id} `;
          const input = parts[4]
            ? msg.message.substring(
                msg.message.indexOf(subCommandTxt) + subCommandTxt.length
              )
            : "";
          if (id) {
            await handleMsgAddDel(msg, input, "add", id);
          }
          return;
        }
        if (subCommand === "ls" || subCommand === "list") {
          await handleMsgList(msg);
          return;
        }
      }
      let target = parts[2];
      if (command === "add" || command === "del") {
        await handleAddDel(msg, target, command);
        return;
      }
      if (command === "ls" || command === "list") {
        await handleList(msg);
        return;
      }
      await msg.edit({
        text: "未知命令, 请使用 <code>.help sure</code> 查看帮助",
        parseMode: "html",
      });
    },
  };

  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    async (msg) => {
      if (msg.fwdFrom) return;
      const uid = extractId(msg.fromId as any);
      const cid = extractId(msg.peerId as any);
      if (!uid || !cid) return;
      if (!getSureIds().includes(uid)) return;
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
        formattingEntities: message.entities,
      });
      if (cmd && sudoMsg)
        await dealCommandPluginWithMessage({
          cmd,
          msg: sudoMsg,
          trigger: msg,
          isEdited: false,
        });
      // if (cmd) {
      //   await dealCommandPluginWithMessage({ cmd, msg });
      // } else {
      //   await msg.client?.sendMessage(msg.peerId, {
      //     message,
      //     replyTo: msg.replyToMsgId,
      //   });
      // }
      await msg.deleteWithDelay(5000);
    };
}
const plugin = new surePlugin();

export default plugin;
