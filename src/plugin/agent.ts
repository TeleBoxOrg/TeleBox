// TeleBox Agent (teleproto) — 平台上适配层
// 所有业务逻辑在 @utils/agentCore.ts 中共享；此文件仅定义 teleproto 专属的 TG API 适配。

import import_teleproto = require("teleproto");
import import_fs = require("fs");
import import_path = require("path");
import { getGlobalClient } from "@utils/runtimeManager";

import {
  initAgentPlatform,
  AgentPlugin,
  type AgentPlatform,
  type AgentOptions,
} from "@utils/agentCore";

// Re-export 所有公开类型
export type {
  ProviderType, AuthMethod, AgentScope, ChatRole,
  AIProvider, ChatImage, ChatMessage, ToolCall, ToolSpec,
  Usage, ModelResponse, ConversationRecord, WorkspaceEntry, WorkspaceRef,
  CommandResult, ToolResult, AgentOptions, RuntimeToolDef,
  AgentRuntime, AgentInput, RunAgentResult, AgentConfig, RuntimeContext,
} from "@utils/agentCore";

// ── teleproto 专属常量和工具函数 ──
const SAFE_MESSAGE_LIMIT = 3900;
const MAX_REPLY_DOWNLOAD = 20 * 1024 * 1024;
const MAX_INLINE_TEXT = 6e4;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = /\.(txt|md|csv|json|jsonl|yaml|yml|toml|ini|cfg|conf|log|py|ts|js|jsx|tsx|sh|bat|ps1|html|htm|xml|sql|go|rs|java|c|cpp|h|cs|php|rb|swift|kt|env|properties)$/i;
const TEXT_MIMES = /^(text\/|application\/(json|javascript|xml|x-yaml|x-sh|x-python|toml|csv|sql|typescript))/i;

function stripTelegramHtml(text: string): string {
  return String(text || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|blockquote|pre)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
}

function truncate2(text: string, max = SAFE_MESSAGE_LIMIT): string {
  const v = String(text || "");
  return v.length <= max ? v : `${v.slice(0, max - 18)}\n\u2026（已截断）`;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "binary");
  return null;
}

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function documentName(message: any): string {
  const attrs = message?.media?.document?.attributes || [];
  return String(attrs.map((a: any) => a?.fileName).find(Boolean) || "");
}

function safeFileName(name: string): string {
  return (import_path.basename(name || "attachment").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "attachment").slice(0, 120);
}

// ── teleproto Platform 实现 ──
const platform: AgentPlatform = {
  async safeEdit(msg: any, text: string, options: AgentOptions = {}) {
    const p = stripTelegramHtml(String(options.plainFallback != null ? options.plainFallback : text));
    try {
      await msg.edit({ text: options.html ? text : truncate2(text), parseMode: options.html ? "html" : void 0, linkPreview: false });
      return msg;
    } catch (err) {
      if (/MESSAGE_NOT_MODIFIED|message (?:is )?not modified/i.test(String(err))) return msg;
      if (options.html) { try { await msg.edit({ text: truncate2(p), linkPreview: false }); return msg; } catch {} }
      try {
        const sent = await msg.reply({ message: options.html ? text : truncate2(text), parseMode: options.html ? "html" : void 0, linkPreview: false });
        return sent || msg;
      } catch {
        if (options.html) { try { const sent = await msg.reply({ message: truncate2(p), linkPreview: false }); return sent || msg; } catch {} }
        return msg;
      }
    }
  },

  async safeReply(msg: any, text: string, options: AgentOptions = {}) {
    const p = stripTelegramHtml(String(options.plainFallback != null ? options.plainFallback : text));
    try {
      const sent = await msg.reply({ message: options.html ? text : truncate2(text), parseMode: options.html ? "html" : void 0, linkPreview: false });
      return sent || null;
    } catch {
      if (options.html) { try { const sent = await msg.reply({ message: truncate2(p), linkPreview: false }); return sent || null; } catch {} }
      return null;
    }
  },

  async buildReplyContext(msg: any, workspace: any) {
    const reply = msg.replyTo?.replyToMsgId ? await msg.getReplyMessage().catch(() => null) : null;
    if (!reply) return { text: "", images: [], savedFiles: [] };
    const text: string[] = [];
    const images: any[] = [];
    const savedFiles: any[] = [];
    const replyText = String(reply.message || reply.text || "").trim();
    if (replyText) text.push(`\u5F15\u7528\u6D88\u606F：\n${replyText}`);
    if (!reply.media) return { text: text.join("\n\n"), images, savedFiles };

    const client = msg.client || await getGlobalClient().catch(() => null);
    if (!client?.downloadMedia) {
      text.push("\u5F15\u7528\u6D88\u606F\u5305\u542B\u5A92\u4F53，\u4F46\u5F53\u524D\u5BA2\u6237\u7AEF\u65E0\u6CD5\u4E0B\u8F7D。");
      return { text: text.join("\n\n"), images, savedFiles };
    }

    const doc = reply.media?.document;
    const mime = String(doc?.mimeType || "").toLowerCase();
    const size = Number(doc?.size || 0);
    const isPhoto = reply.media instanceof import_teleproto.Api.MessageMediaPhoto || reply.media?.className === "MessageMediaPhoto";

    if (size > MAX_REPLY_DOWNLOAD) {
      text.push(`\u5F15\u7528\u6587\u4EF6\u8FC7\u5927，\u672A\u4E0B\u8F7D：${documentName(reply) || "\u672A\u77E5\u6587\u4EF6"}（${size} bytes）`);
      return { text: text.join("\n\n"), images, savedFiles };
    }

    const buffer = toBuffer(await client.downloadMedia(reply, {}).catch(() => null));
    if (!buffer) { text.push("\u5F15\u7528\u5A92\u4F53\u4E0B\u8F7D\u5931\u8D25。"); return { text: text.join("\n\n"), images, savedFiles }; }

    const detected = detectImageMime(buffer) || mime;
    if (isPhoto || IMAGE_MIMES.has(detected)) {
      if (IMAGE_MIMES.has(detected)) {
        images.push({ mimeType: detected, base64: buffer.toString("base64") });
        text.push("\u5F15\u7528\u6D88\u606F\u5305\u542B\u56FE\u7247，\u56FE\u7247\u5DF2\u63D0\u4F9B\u7ED9\u6A21\u578B。");
      }
      return { text: text.join("\n\n"), images, savedFiles };
    }

    const inbox = import_path.join(workspace.dir, "inbox");
    await import_fs.promises.mkdir(inbox, { recursive: true });
    const fileName = `${Date.now()}_${safeFileName(documentName(reply) || "attachment")}`;
    const savedPath = import_path.join(inbox, fileName);
    await import_fs.promises.writeFile(savedPath, buffer);
    const wsp = `$workspace/inbox/${fileName}`;
    savedFiles.push(wsp);
    text.push(`\u5F15\u7528\u6587\u4EF6\u5DF2\u4FDD\u5B58：${wsp}\n\u7C7B\u578B：${mime || "\u672A\u77E5"}\n\u5927\u5C0F：${buffer.length} bytes`);
    if ((TEXT_EXTENSIONS.test(fileName) || TEXT_MIMES.test(mime)) && buffer.length <= MAX_INLINE_TEXT) {
      text.push(`\u6587\u4EF6\u5185\u5BB9：\n\`\`\`\n${buffer.toString("utf-8")}\n\`\`\``);
    }
    return { text: text.join("\n\n"), images, savedFiles };
  },

  async sendFile(client: any, msg: any, filePath: string, caption: string) {
    await client.sendFile(msg.peerId, {
      file: filePath,
      caption,
      replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || void 0,
    });
  },
};

initAgentPlatform(platform);
export default new AgentPlugin();
