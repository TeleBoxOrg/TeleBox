import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/runtimeManager";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs/promises";
import { statSync, existsSync } from "fs";

import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

interface UserConfig {
  target: string;
  showSource: boolean;
}

interface SaveDB {
  users: Record<string, UserConfig>;
}

interface LocalSavedFile {
  filePath: string;
  metadataPath: string;
  relativeFilePath: string;
  relativeMetadataPath: string;
  sourceChatId: string;
  sourceChatTitle: string;
  sourceMessageId: number;
  sourceLink: string;
  mediaType: string;
  groupedId?: string;
}

interface ProcessMessageResult {
  success: boolean;
  skipped?: boolean;
  forwardedMsg?: Api.Message;
  savedFile?: LocalSavedFile;
  source?: { chatId: string; messageId: number };
}

const help_text = `💾 <b>save — 突破限制保存 / 转发消息</b>

<b>命令：</b>
• <code>${mainPrefix}save</code> — 回复消息：转发到默认目标
• <code>${mainPrefix}save &lt;链接…&gt;</code> — 批量转发链接
• <code>${mainPrefix}save &lt;链接1&gt;|&lt;链接2&gt;</code> — 保存两链接之间的消息范围
• <code>${mainPrefix}save &lt;链接&gt; &lt;临时目标&gt;</code> — 临时改目标（可用 local）

<b>设置：</b>
• <code>${mainPrefix}save to &lt;目标&gt;</code> — 默认目标（@user / chatid / me / local）
• <code>${mainPrefix}save target</code> — 查看默认目标
• <code>${mainPrefix}save source on|off</code> — 转发后来源链接
• <code>${mainPrefix}save source</code> — 查看来源开关

<b>local 模式：</b>
媒体保存到 <code>save/&lt;chatId&gt;/</code>，旁路 <code>.json</code> 元数据；纯文本跳过。`;

class SavePlugin extends Plugin {
  cleanup(): void {
    this.lastEditText.clear();
    this.chatDisplayNameCache.clear();
    this.db = null;
    for (const filePath of this.activeTempFiles) {
      void fs.unlink(filePath).catch(() => {});
    }
    this.activeTempFiles.clear();
    void this.cleanupTempDirectory();
  }

  async setup(): Promise<void> {
    await this.initDB();
  }

  name = "save";
  description = help_text;
  
  private tempDir = createDirectoryInTemp("prometheus");
  private db: Awaited<ReturnType<typeof JSONFilePreset<SaveDB>>> | null = null;
  private lastEditText: Map<string, string> = new Map();
  private chatDisplayNameCache: Map<string, string> = new Map();
  private activeTempFiles: Set<string> = new Set();

  private isLocalTarget(target: string): boolean {
    return target.trim().toLowerCase() === "local";
  }

  private sanitizePathSegment(value: string, fallback: string): string {
    const sanitized = value
      .trim()
      .replace(/[^a-zA-Z0-9_\-.\u4e00-\u9fff]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);

    return sanitized || fallback;
  }

  private getLocalSaveRoot(): string {
    return path.join(process.cwd(), "save");
  }

  private buildUniquePath(dirPath: string, fileName: string): string {
    const parsed = path.parse(fileName);
    const baseName = parsed.name || "file";
    const extension = parsed.ext || "";
    let candidate = path.join(dirPath, `${baseName}${extension}`);
    let counter = 1;

    while (existsSync(candidate)) {
      candidate = path.join(dirPath, `${baseName}_${counter}${extension}`);
      counter++;
    }

    return candidate;
  }

  private async moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    try {
      await fs.rename(sourcePath, destinationPath);
    } catch {
      await fs.copyFile(sourcePath, destinationPath);
      await fs.unlink(sourcePath);
    }
  }

  private async saveLocalMetadata(filePath: string, metadata: Record<string, unknown>): Promise<string> {
    const parsed = path.parse(filePath);
    const metadataPath = this.buildUniquePath(parsed.dir, `${parsed.name}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    return metadataPath;
  }

  private async ensureLocalChatDirectory(chatId: string): Promise<{ rootDir: string; chatDir: string; displayName: string }> {
    const rootDir = this.getLocalSaveRoot();
    await fs.mkdir(rootDir, { recursive: true });

    const displayName = await this.getChatDisplayName(chatId);
    const dirName = this.sanitizePathSegment(chatId, "chat");
    const chatDir = path.join(rootDir, dirName);
    await fs.mkdir(chatDir, { recursive: true });

    return { rootDir, chatDir, displayName };
  }

  private getLocalChatRelativeDirectory(chatId: string): string {
    const chatDir = path.join(this.getLocalSaveRoot(), this.sanitizePathSegment(chatId, "chat"));
    return path.relative(process.cwd(), chatDir) || chatDir;
  }

  private formatLocalDirectorySummary(savedFiles: LocalSavedFile[]): string {
    const directories = Array.from(
      new Set(savedFiles.map((file) => this.getLocalChatRelativeDirectory(file.sourceChatId)))
    ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    if (directories.length === 0) {
      return `目录: <code>${htmlEscape(path.relative(process.cwd(), this.getLocalSaveRoot()) || this.getLocalSaveRoot())}</code>`;
    }

    if (directories.length === 1) {
      return `目录: <code>${htmlEscape(directories[0])}</code>`;
    }

    const body = directories.map((dir) => `<code>${htmlEscape(dir)}</code>`).join('\n');
    return `目录摘要:\n<blockquote expandable>${body}</blockquote>`;
  }

  private formatSourceLine(chatLabel: string, chatId: string, messageId: number): string {
    const sourceLink = this.generateMessageLink(chatId, messageId);
    return `• <b>${htmlEscape(chatLabel)}</b> / <a href="${htmlEscape(sourceLink)}">${messageId}</a>`;
  }

  private compactMessageIds(messageIds: number[]): Array<{ start: number; end: number }> {
    if (messageIds.length === 0) return [];

    const sortedIds = Array.from(new Set(messageIds)).sort((a, b) => a - b);
    const ranges: Array<{ start: number; end: number }> = [];

    let start = sortedIds[0];
    let end = sortedIds[0];

    for (let i = 1; i < sortedIds.length; i++) {
      const current = sortedIds[i];
      if (current === end + 1) {
        end = current;
        continue;
      }

      ranges.push({ start, end });
      start = current;
      end = current;
    }

    ranges.push({ start, end });
    return ranges;
  }

  private formatSourceRange(chatId: string, start: number, end: number): string {
    const startLink = this.generateMessageLink(chatId, start);
    if (start === end) {
      return `<a href="${htmlEscape(startLink)}">${start}</a>`;
    }

    const endLink = this.generateMessageLink(chatId, end);
    return `<a href="${htmlEscape(startLink)}">${start}</a>-<a href="${htmlEscape(endLink)}">${end}</a>`;
  }

  private async getChatDisplayName(chatId: string): Promise<string> {
    const cachedName = this.chatDisplayNameCache.get(chatId);
    if (cachedName) {
      return cachedName;
    }

    try {
      const client = await getGlobalClient();
      const entity = await client.getEntity(chatId);

      const title =
        (entity as any)?.title ||
        [
          (entity as any)?.firstName,
          (entity as any)?.lastName,
        ].filter(Boolean).join(' ').trim() ||
        (entity as any)?.username;

      const resolvedName = title ? String(title) : chatId;
      this.chatDisplayNameCache.set(chatId, resolvedName);
      return resolvedName;
    } catch {
      this.chatDisplayNameCache.set(chatId, chatId);
      return chatId;
    }
  }

  private async sendSingleSourceMessage(
    targetPeer: any,
    sourceChatId: string,
    sourceMessageId: number,
    forwardedMsg: Api.Message,
    replyMsg?: Api.Message
  ): Promise<void> {
    try {
      const client = await getGlobalClient();
      const sourceLink = this.generateMessageLink(sourceChatId, sourceMessageId);
      const displayName = await this.getChatDisplayName(sourceChatId);
      const sourceText = `🔗 <b>消息来源</b>\n\n` +
        `📝 <a href="${htmlEscape(sourceLink)}">查看原消息</a>\n` +
        `👤 来源对话: <b>${htmlEscape(displayName)}</b>\n` +
        `#️⃣ 消息ID: <code>${sourceMessageId}</code>`;

      await client.sendMessage(targetPeer, {
        message: sourceText,
        parseMode: 'html',
        replyTo: forwardedMsg.id
      });

      if (replyMsg) {
        await this.safeEditMessage(replyMsg, `✅ 已转发并添加来源链接`, true);
      }
    } catch (error) {
      console.error(`发送来源消息失败:`, error);
    }
  }

  private async sendBatchSourceSummary(
    targetPeer: any,
    forwardedMsg: Api.Message,
    sources: Array<{ chatId: string; messageId: number }>
  ): Promise<void> {
    if (sources.length === 0) return;

    try {
      const client = await getGlobalClient();
      const grouped = new Map<string, number[]>();

      for (const source of sources) {
        const current = grouped.get(source.chatId) || [];
        current.push(source.messageId);
        grouped.set(source.chatId, current);
      }

      const sections = await Promise.all(Array.from(grouped.entries()).map(async ([chatId, messageIds]) => {
        const uniqueIds = Array.from(new Set(messageIds)).sort((a, b) => a - b);
        const ranges = this.compactMessageIds(uniqueIds).sort((a, b) => a.start - b.start);
        const rangeText = ranges
          .map((range) => this.formatSourceRange(chatId, range.start, range.end))
          .join(', ');
        const displayName = await this.getChatDisplayName(chatId);
        return {
          chatId,
          displayName,
          text: `👤 <b>${htmlEscape(displayName)}</b>（${uniqueIds.length} 条）：${rangeText}`,
        };
      }));

      sections.sort((a, b) => {
        const titleCompare = a.displayName.localeCompare(b.displayName, 'zh-Hans-CN');
        if (titleCompare !== 0) return titleCompare;
        return a.chatId.localeCompare(b.chatId, 'zh-Hans-CN');
      });

      const summaryBody = sections.map((section) => section.text).join('\n');
      const wrappedBody = summaryBody.length > 350 || sections.length > 6
        ? `<blockquote expandable>${summaryBody}</blockquote>`
        : summaryBody;
      const sourceText = `🔗 <b>批量保存来源</b>\n\n${wrappedBody}`;

      await client.sendMessage(targetPeer, {
        message: sourceText,
        parseMode: 'html',
        replyTo: forwardedMsg.id
      });
    } catch (error) {
      console.error(`发送批量来源消息失败:`, error);
    }
  }

  private async sendRangeSourceSummary(
    targetPeer: any,
    forwardedMsg: Api.Message,
    startSource: { chatId: string; messageId: number } | null,
    endSource: { chatId: string; messageId: number } | null
  ): Promise<void> {
    if (!startSource && !endSource) return;

    try {
      const client = await getGlobalClient();
      const blocks: string[] = [];

      if (startSource) {
        const startTitle = await this.getChatDisplayName(startSource.chatId);
        blocks.push(`▶️ <b>起始消息</b>\n${this.formatSourceLine(startTitle, startSource.chatId, startSource.messageId)}`);
      }

      if (endSource) {
        const endTitle = await this.getChatDisplayName(endSource.chatId);
        blocks.push(`⏹ <b>结尾消息</b>\n${this.formatSourceLine(endTitle, endSource.chatId, endSource.messageId)}`);
      }

      await client.sendMessage(targetPeer, {
        message: `🔗 <b>范围保存来源</b>\n\n${blocks.join('\n\n')}`,
        parseMode: 'html',
        replyTo: forwardedMsg.id
      });
    } catch (error) {
      console.error(`发送范围来源消息失败:`, error);
    }
  }
  
  private async safeEditMessage(
    msg: Api.Message,
    text: string,
    force: boolean = false
  ): Promise<void> {
    const msgId = `${msg.chatId}_${msg.id}`;
    const lastText = this.lastEditText.get(msgId);

    // 关键兜底：绝对不给空字符串
    const safeText = text?.trim() || ' '; // 用不可见空格占位
    if (!force && lastText === safeText) return;

    try {
      await msg.edit({ text: safeText, parseMode: 'html' });
      this.lastEditText.set(msgId, safeText);
    } catch (err: any) {
      if (err.message?.includes('MESSAGE_NOT_MODIFIED')) {
        this.lastEditText.set(msgId, safeText);
        return;
      }
      throw err;
    }
  }
  
  private async initDB(): Promise<void> {
    try {
      const dbPath = path.join(createDirectoryInAssets("prometheus"), "config.json");
      this.db = await JSONFilePreset<SaveDB>(dbPath, { users: {} });
    } catch (error) {
      console.error(`初始化数据库失败:`, error);
    }
  }
  
  private ensureDb(): NonNullable<typeof this.db> {
    if (!this.db) {
      throw new Error("save database is not initialized");
    }
    return this.db;
  }

  private async getUserConfig(userId: string): Promise<UserConfig> {
    await this.initDB();
    const db = this.ensureDb();
    if (!db.data.users[userId]) {
      db.data.users[userId] = {
        target: "me",
        showSource: false,
      };
      await db.write();
    }
    return db.data.users[userId];
  }

  private async setUserConfig(userId: string, config: Partial<UserConfig>): Promise<void> {
    await this.initDB();
    const db = this.ensureDb();
    if (!db.data.users[userId]) {
      db.data.users[userId] = {
        target: "me",
        showSource: false,
      };
    }
    Object.assign(db.data.users[userId], config);
    await db.write();
  }

  /** t.me/c links need the internal id without the -100 prefix. */
  private generateMessageLink(chatId: string, messageId: number): string {
    if (/^-?\d+$/.test(chatId)) {
      let internal = chatId;
      if (internal.startsWith("-100")) {
        internal = internal.slice(4);
      } else if (internal.startsWith("-")) {
        internal = internal.slice(1);
      }
      return `https://t.me/c/${internal}/${messageId}`;
    }
    return `https://t.me/${chatId}/${messageId}`;
  }
  
  private parseMessageLink(link: string): { chatId: string; messageId: number } | null {
    const cleanLink = link.split('?')[0];
    
    const patterns = [
      /(?:https?:\/\/)?t\.me\/c\/(-?\d+)\/(\d+)/,
      /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)\/(\d+)/,
    ];
    
    for (const pattern of patterns) {
      const match = cleanLink.match(pattern);
      if (match) {
        let chatId = match[1];
        const messageId = parseInt(match[2]);
        
        if (/^-?\d+$/.test(chatId) && !chatId.startsWith('-100') && chatId.startsWith('-')) {
          chatId = `-100${chatId.substring(1)}`;
        } else if (/^\d+$/.test(chatId) && parseInt(chatId) > 0) {
          chatId = `-100${chatId}`;
        }
        
        return { chatId, messageId };
      }
    }
    
    return null;
  }
  
  private async getMessage(chatId: string, messageId: number): Promise<Api.Message | null> {
    try {
      const client = await getGlobalClient();
      const peer = await client.getInputEntity(chatId);
      const messages = await client.getMessages(peer, { ids: [messageId] });
      return messages[0] || null;
    } catch (error) {
      console.error(`获取消息失败:`, error);
      return null;
    }
  }
  
  private getFileExtension(media: Api.TypeMessageMedia): string {
    try {
      if (media instanceof Api.MessageMediaPhoto) {
        return '.jpg';
      } else if (media instanceof Api.MessageMediaDocument) {
        const document = media.document as Api.Document;
        
        if (document.mimeType) {
          const mimeType = document.mimeType.toLowerCase();
          if (mimeType.includes('video/mp4')) return '.mp4';
          if (mimeType.includes('video/webm')) return '.webm';
          if (mimeType.includes('video/quicktime')) return '.mov';
          if (mimeType.includes('audio/mpeg')) return '.mp3';
          if (mimeType.includes('audio/ogg')) return '.ogg';
          if (mimeType.includes('image/jpeg') || mimeType.includes('image/jpg')) return '.jpg';
          if (mimeType.includes('image/png')) return '.png';
          if (mimeType.includes('image/gif')) return '.gif';
          if (mimeType.includes('image/webp')) return '.webp';
        }
        
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeFilename) {
            const ext = path.extname(attr.fileName).toLowerCase();
            if (ext) return ext;
          }
        }
        
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeVideo) return '.mp4';
          if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? '.ogg' : '.mp3';
          if (attr instanceof Api.DocumentAttributeSticker) return '.webp';
          if (attr instanceof Api.DocumentAttributeAnimated) return '.gif';
        }
      }
    } catch (error) {
      console.error(`获取文件扩展名失败:`, error);
    }
    
    return '.bin';
  }
  
  private getMediaType(media: Api.TypeMessageMedia): string {
    try {
      if (media instanceof Api.MessageMediaPhoto) {
        return 'photo';
      } else if (media instanceof Api.MessageMediaDocument) {
        const document = media.document as Api.Document;
        
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeVideo) return 'video';
          if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? 'voice' : 'audio';
          if (attr instanceof Api.DocumentAttributeSticker) return 'sticker';
          if (attr instanceof Api.DocumentAttributeAnimated) return 'gif';
        }
        
        if (document.mimeType?.includes('video/')) return 'video';
        if (document.mimeType?.includes('audio/')) return 'audio';
        if (document.mimeType?.includes('image/')) return 'photo';
      }
    } catch (error) {
      console.error(`获取媒体类型失败:`, error);
    }
    
    return 'document';
  }
  
  private async downloadMedia(message: Api.Message, index: number = 0, replyMsg?: Api.Message): Promise<{ 
    path: string; 
    type: string;
    caption?: string;
    fileName?: string;
  } | null> {
    try {
      const client = await getGlobalClient();
      
      if (!message.media) return null;
      
      const mediaType = this.getMediaType(message.media);
      const extension = this.getFileExtension(message.media);
      
      const timestamp = Date.now();
      let fileName = `${mediaType}_${timestamp}_${index}`;
      
      if (message.media instanceof Api.MessageMediaDocument) {
        const document = message.media.document as Api.Document;
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeFilename) {
            const baseName = path.parse(attr.fileName).name;
            if (baseName) fileName = baseName;
            break;
          }
        }
      }
      
      const safeName = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const finalFileName = `${safeName}${extension}`;
      const filePath = path.join(this.tempDir, finalFileName);
      
      let finalFilePath = filePath;
      let counter = 1;
      while (existsSync(finalFilePath)) {
        const baseName = path.parse(safeName).name;
        finalFilePath = path.join(this.tempDir, `${baseName}_${counter}${extension}`);
        counter++;
      }
      
      if (replyMsg) {
        await this.safeEditMessage(replyMsg, `⏬ 下载媒体文件 (${index + 1})...`);
      }
      
      const buffer = await client.downloadMedia(message.media, {});
      if (buffer && buffer.length > 0) {
        await fs.writeFile(finalFilePath, buffer);
        this.activeTempFiles.add(finalFilePath);
      } else {
        return null;
      }
      
      if (!existsSync(finalFilePath)) {
        return null;
      }
      
      const stats = statSync(finalFilePath);
      if (stats.size === 0) {
        return null;
      }
      
      return {
        path: finalFilePath,
        type: mediaType,
        caption: message.text || undefined,
        fileName: path.basename(finalFilePath),
      };
      
    } catch (error: any) {
      console.error(`下载媒体失败:`, error);
      return null;
    }
  }
  
  private async cleanupTempFile(filePath: string | null): Promise<void> {
    if (filePath && existsSync(filePath)) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        console.error(`清理临时文件失败:`, error);
      }
    }
    if (filePath) {
      this.activeTempFiles.delete(filePath);
    }
  }

  private async cleanupTempDirectory(): Promise<void> {
    try {
      const entries = await fs.readdir(this.tempDir);
      await Promise.all(
        entries.map(async (entry) => {
          const filePath = path.join(this.tempDir, entry);
          try {
            await fs.unlink(filePath);
          } catch {}
        })
      );
    } catch {}
  }

  private async saveMediaToLocal(
    sourceMsg: Api.Message,
    sourceChatId: string,
    sourceMessageId: number,
    replyMsg?: Api.Message,
    index: number = 0,
    options?: { groupDirName?: string }
  ): Promise<LocalSavedFile | null> {
    let tempFileInfo: {
      path: string;
      type: string;
      caption?: string;
      fileName?: string;
    } | null = null;

    try {
      if (!sourceMsg.media) {
        return null;
      }

      tempFileInfo = await this.downloadMedia(sourceMsg, index, replyMsg);
      if (!tempFileInfo) {
        return null;
      }

      const { chatDir, displayName } = await this.ensureLocalChatDirectory(sourceChatId);
      const finalDir = options?.groupDirName
        ? path.join(chatDir, this.sanitizePathSegment(options.groupDirName, "group"))
        : chatDir;
      await fs.mkdir(finalDir, { recursive: true });
      const originalName = tempFileInfo.fileName || path.basename(tempFileInfo.path);
      const parsedOriginal = path.parse(originalName);
      const safeBaseName = this.sanitizePathSegment(parsedOriginal.name || tempFileInfo.type || "media", tempFileInfo.type || "media");
      const safeExtension = parsedOriginal.ext || path.extname(originalName) || ".bin";
      const finalFileName = `msg_${sourceMessageId}_${safeBaseName}${safeExtension}`;
      const finalFilePath = this.buildUniquePath(finalDir, finalFileName);

      await this.moveFile(tempFileInfo.path, finalFilePath);
      this.activeTempFiles.delete(tempFileInfo.path);
      tempFileInfo = null;

      const metadataPath = await this.saveLocalMetadata(finalFilePath, {
        savedAt: new Date().toISOString(),
        source: {
          chatId: sourceChatId,
          chatTitle: displayName,
          messageId: sourceMessageId,
          link: this.generateMessageLink(sourceChatId, sourceMessageId),
        },
        media: {
          type: sourceMsg.media ? this.getMediaType(sourceMsg.media) : null,
          fileName: path.basename(finalFilePath),
          originalFileName: originalName,
          fileSize: statSync(finalFilePath).size,
          caption: sourceMsg.text || "",
        },
      });

      return {
        filePath: finalFilePath,
        metadataPath,
        relativeFilePath: path.relative(process.cwd(), finalFilePath) || finalFilePath,
        relativeMetadataPath: path.relative(process.cwd(), metadataPath) || metadataPath,
        sourceChatId,
        sourceChatTitle: displayName,
        sourceMessageId,
        sourceLink: this.generateMessageLink(sourceChatId, sourceMessageId),
        mediaType: sourceMsg.media ? this.getMediaType(sourceMsg.media) : "unknown",
        groupedId: sourceMsg.groupedId?.toString(),
      };
    } catch (error) {
      console.error(`保存媒体到本地失败:`, error);
      if (tempFileInfo?.path) {
        await this.cleanupTempFile(tempFileInfo.path);
      }
      return null;
    }
  }
  
  private async sendSingleMedia(
    client: any,
    targetPeer: any,
    mediaInfo: { 
      path: string; 
      type: string; 
      caption?: string;
      fileName?: string;
    },
    replyMsg?: Api.Message
  ): Promise<Api.Message> {
    const { path: filePath, type, caption, fileName } = mediaInfo;
    
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    
    const sendOptions: any = {
      file: filePath,
      forceDocument: false
    };
    
    if (caption && type !== 'voice' && type !== 'sticker') {
      sendOptions.caption = caption;
      sendOptions.parseMode = caption.includes('<') ? 'html' : undefined;
    }
    
    if (replyMsg) {
      await this.safeEditMessage(replyMsg, `📤 上传 ${type}...`);
    }
    
    return await client.sendFile(targetPeer, sendOptions);
  }
  
  private async processMessage(
    sourceMsg: Api.Message, 
    targetPeer: any, 
    replyMsg: Api.Message,
    sourceChatId: string,
    sourceMessageId: number,
    progress: string = ""
  ): Promise<ProcessMessageResult> {
    const client = await getGlobalClient();
    let tempFileInfo: any = null;
    let forwardedMessage: Api.Message | undefined;
    
    try {
      await this.safeEditMessage(replyMsg, `${progress}🔄 尝试直接转发...`, true);
      
      try {
        // 直接转发，获取转发的消息
        const result = await client.forwardMessages(targetPeer, {
          messages: [sourceMsg.id],
          fromPeer: sourceMsg.peerId
        });
        forwardedMessage = result[0];
        
        await this.safeEditMessage(replyMsg, `${progress}✅ 转发成功`, true);
        
        // 如果开启了来源显示，发送来源消息
        return {
          success: true,
          forwardedMsg: forwardedMessage,
          source: { chatId: sourceChatId, messageId: sourceMessageId }
        };
      } catch (forwardError: any) {
        const errorMsg = forwardError.message || '';
        const isRestricted = errorMsg.includes('SAVE') || 
                           errorMsg.includes('FORWARD') || 
                           errorMsg.includes('CHAT_FORWARDS_RESTRICTED');
        
        if (!isRestricted) throw forwardError;
        
        if (!sourceMsg.media) {
          const text = sourceMsg.text || '';
          if (text) {
            // 发送文本消息，获取发送的消息
            forwardedMessage = await client.sendMessage(targetPeer, {
              message: text,
              parseMode: sourceMsg.text?.includes('<') ? 'html' : undefined
            });
            
            await this.safeEditMessage(replyMsg, `${progress}✅ 文本内容已发送`, true);
            
            // 如果开启了来源显示，发送来源消息
            return {
              success: true,
              forwardedMsg: forwardedMessage,
              source: { chatId: sourceChatId, messageId: sourceMessageId }
            };
          } else {
            await this.safeEditMessage(replyMsg, `${progress}❌ 消息无内容可转发`, true);
            return { success: false };
          }
        }
        
        tempFileInfo = await this.downloadMedia(sourceMsg, 0, replyMsg);
        if (!tempFileInfo) {
          await this.safeEditMessage(replyMsg, `${progress}❌ 下载媒体失败`, true);
          return { success: false };
        }
        
        // 发送媒体消息，获取发送的消息
        forwardedMessage = await this.sendSingleMedia(client, targetPeer, tempFileInfo, replyMsg);
        await this.safeEditMessage(replyMsg, `${progress}✅ 内容已重新上传发送`, true);
        
        // 如果开启了来源显示，发送来源消息
        return {
          success: true,
          forwardedMsg: forwardedMessage,
          source: { chatId: sourceChatId, messageId: sourceMessageId }
        };
      }
    } catch (error: any) {
      console.error(`处理消息失败:`, error);
      await this.safeEditMessage(replyMsg, `${progress}❌ 处理失败: ${htmlEscape(error.message || "未知错误")}`, true);
      return { success: false };
    } finally {
      if (tempFileInfo?.path) {
        await this.cleanupTempFile(tempFileInfo.path);
      }
    }
  }

  private async processMessageToLocal(
    sourceMsg: Api.Message,
    replyMsg: Api.Message,
    sourceChatId: string,
    sourceMessageId: number,
    progress: string = "",
    options?: { groupDirName?: string; quietSuccess?: boolean }
  ): Promise<ProcessMessageResult> {
    try {
      if (!sourceMsg.media) {
        await this.safeEditMessage(replyMsg, `${progress}⏭️ 消息不包含媒体文件，已跳过`, true);
        return { success: false, skipped: true };
      }

      await this.safeEditMessage(replyMsg, `${progress}💾 正在保存媒体到本地...`, true);
      const savedFile = await this.saveMediaToLocal(sourceMsg, sourceChatId, sourceMessageId, replyMsg, 0, options);

      if (!savedFile) {
        await this.safeEditMessage(replyMsg, `${progress}❌ 保存到本地失败`, true);
        return { success: false };
      }

      if (!options?.quietSuccess) {
        await this.safeEditMessage(replyMsg, `${progress}✅ 已保存到本地`, true);
      }

      return {
        success: true,
        savedFile,
        source: { chatId: sourceChatId, messageId: sourceMessageId },
      };
    } catch (error: any) {
      console.error(`处理本地保存失败:`, error);
      await this.safeEditMessage(replyMsg, `${progress}❌ 本地保存失败: ${htmlEscape(error.message || "未知错误")}`, true);
      return { success: false };
    }
  }
  
  private async processMessageRange(
    chatId: string,
    startId: number,
    endId: number,
    targetPeer: any,
    replyMsg: Api.Message,
    showSource: boolean
  ): Promise<{ total: number; success: number; lastForwardedMsg?: Api.Message; startSource: { chatId: string; messageId: number } | null; endSource: { chatId: string; messageId: number } | null }> {
    let successCount = 0;
    let totalProcessed = 0;
    let lastForwardedMsg: Api.Message | undefined;
    let startSource: { chatId: string; messageId: number } | null = null;
    let endSource: { chatId: string; messageId: number } | null = null;
    
    // 确保startId <= endId
    const actualStart = Math.min(startId, endId);
    const actualEnd = Math.max(startId, endId);
    const totalMessages = actualEnd - actualStart + 1;
    
    await this.safeEditMessage(replyMsg, `🔄 开始处理消息范围 ${actualStart}-${actualEnd} (共${totalMessages}条)...`, true);
    
    for (let msgId = actualStart; msgId <= actualEnd; msgId++) {
      totalProcessed++;
      const progress = `[${totalProcessed}/${totalMessages}] `;
      
      try {
        await this.safeEditMessage(replyMsg, `${progress}🔍 获取消息 ${msgId}...`, true);
        const sourceMsg = await this.getMessage(chatId, msgId);
        
        if (!sourceMsg) {
          await this.safeEditMessage(replyMsg, `${progress}⏭️ 消息 ${msgId} 不存在，跳过`, true);
          continue;
        }
        
        await this.safeEditMessage(replyMsg, `${progress}🔄 处理消息 ${msgId}...`, true);
        const result = await this.processMessage(
          sourceMsg, 
          targetPeer, 
          replyMsg, 
          chatId, 
          msgId,
          progress
        );
        
        if (result.success) {
          successCount++;
          if (result.forwardedMsg) {
            lastForwardedMsg = result.forwardedMsg;
          }
          if (!startSource && result.source) {
            startSource = result.source;
          }
          if (result.source) {
            endSource = result.source;
          }
          await this.safeEditMessage(replyMsg, `${progress}✅ 消息 ${msgId} 处理完成`, true);
        } else {
          await this.safeEditMessage(replyMsg, `${progress}❌ 消息 ${msgId} 处理失败`, true);
        }
      } catch (error: any) {
        await this.safeEditMessage(replyMsg, `${progress}❌ 消息 ${msgId} 处理出错: ${htmlEscape(error.message || "未知错误")}`, true);
      }
      
      // 延迟以避免触发限制
      if (msgId < actualEnd) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (showSource && lastForwardedMsg) {
      await this.sendRangeSourceSummary(targetPeer, lastForwardedMsg, startSource, endSource);
    }

    return { total: totalProcessed, success: successCount, lastForwardedMsg, startSource, endSource };
  }

  private async processMessageRangeToLocal(
    chatId: string,
    startId: number,
    endId: number,
    replyMsg: Api.Message
  ): Promise<{ total: number; saved: number; skipped: number; failed: number; savedFiles: LocalSavedFile[] }> {
    let savedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalProcessed = 0;
    const savedFiles: LocalSavedFile[] = [];

    const actualStart = Math.min(startId, endId);
    const actualEnd = Math.max(startId, endId);
    const totalMessages = actualEnd - actualStart + 1;

    await this.safeEditMessage(replyMsg, `🔄 开始保存消息范围 ${actualStart}-${actualEnd} 到本地 (共${totalMessages}条)...`, true);

    for (let msgId = actualStart; msgId <= actualEnd; msgId++) {
      totalProcessed++;
      const progress = `[${totalProcessed}/${totalMessages}] `;

      try {
        await this.safeEditMessage(replyMsg, `${progress}🔍 获取消息 ${msgId}...`, true);
        const sourceMsg = await this.getMessage(chatId, msgId);

        if (!sourceMsg) {
          skippedCount++;
          await this.safeEditMessage(replyMsg, `${progress}⏭️ 消息 ${msgId} 不存在，跳过`, true);
          continue;
        }

        const result = await this.processMessageToLocal(sourceMsg, replyMsg, chatId, msgId, progress);
        if (result.success && result.savedFile) {
          savedCount++;
          savedFiles.push(result.savedFile);
        } else if (result.skipped) {
          skippedCount++;
        } else {
          failedCount++;
        }
      } catch (error: any) {
        failedCount++;
        await this.safeEditMessage(replyMsg, `${progress}❌ 消息 ${msgId} 本地保存出错: ${htmlEscape(error.message || "未知错误")}`, true);
      }

      if (msgId < actualEnd) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return { total: totalProcessed, saved: savedCount, skipped: skippedCount, failed: failedCount, savedFiles };
  }

  private async writeLocalSaveIndex(savedFiles: LocalSavedFile[]): Promise<{ indexPath: string; relativeIndexPath: string } | null> {
    if (savedFiles.length === 0) {
      return null;
    }

    const rootDir = this.getLocalSaveRoot();
    await fs.mkdir(rootDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const indexPath = this.buildUniquePath(rootDir, `index_${timestamp}.json`);
    const groupedChats = new Map<string, { chatTitle: string; items: LocalSavedFile[] }>();

    for (const savedFile of savedFiles) {
      const current = groupedChats.get(savedFile.sourceChatId) || {
        chatTitle: savedFile.sourceChatTitle,
        items: [],
      };
      current.items.push(savedFile);
      groupedChats.set(savedFile.sourceChatId, current);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      totalFiles: savedFiles.length,
      chats: Array.from(groupedChats.entries()).map(([chatId, group]) => ({
        chatId,
        chatTitle: group.chatTitle,
        count: group.items.length,
        files: group.items
          .slice()
          .sort((a, b) => a.sourceMessageId - b.sourceMessageId)
          .map((item) => ({
            sourceMessageId: item.sourceMessageId,
            sourceLink: item.sourceLink,
            mediaType: item.mediaType,
            groupedId: item.groupedId || null,
            filePath: item.relativeFilePath,
            metadataPath: item.relativeMetadataPath,
          })),
      })),
    };

    await fs.writeFile(indexPath, JSON.stringify(payload, null, 2), "utf8");
    return {
      indexPath,
      relativeIndexPath: path.relative(process.cwd(), indexPath) || indexPath,
    };
  }
  
  private async handleCommand(msg: Api.Message): Promise<void> {
    try {
      const client = await getGlobalClient();
      if (!client) {
        await this.safeEditMessage(msg, "❌ 客户端未初始化", true);
        return;
      }
      
      const userId = msg.senderId?.toString() || "unknown";
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      
      // 检查是否有回复消息
      const replyMsg = await msg.getReplyMessage();
      
      // 处理source子命令
      if (parts.length >= 2 && parts[1].toLowerCase() === "source") {
        const config = await this.getUserConfig(userId);
        
        if (parts.length === 2) {
          // 查看当前状态
          const status = config.showSource ? "开启 ✅" : "关闭 ❌";
          await this.safeEditMessage(msg, `📊 来源显示功能: <b>${status}</b>\n\n`, true);
          return;
        }
        
        const action = parts[2].toLowerCase();
        if (action === "on") {
          await this.setUserConfig(userId, { showSource: true });
          await this.safeEditMessage(msg, "✅ 已开启来源显示功能\n\n转发消息后，将回复一条包含原消息链接的来源消息。", true);
        } else if (action === "off") {
          await this.setUserConfig(userId, { showSource: false });
          await this.safeEditMessage(msg, "❌ 已关闭来源显示功能\n\n转发消息后，将不再显示来源链接。", true);
        } else {
            await this.safeEditMessage(msg, `❌ 无效的参数\n\n使用: <code>${mainPrefix}save source on/off</code>`, true);
        }
        return;
      }
      
      // 处理子命令
      if (parts.length >= 2 && parts[1].toLowerCase() === "to") {
        if (parts.length < 3) {
          await this.safeEditMessage(msg, `❌ 请指定转发目标\n\n💡 示例:\n<code>${mainPrefix}save to @username</code>\n<code>${mainPrefix}save to -123456780</code>\n<code>${mainPrefix}save to me</code>\n<code>${mainPrefix}save to local</code>`, true);
          return;
        }
        
        const target = parts.slice(2).join(" ");
        await this.setUserConfig(userId, { target });
        await this.safeEditMessage(msg, `✅ 已设置默认转发目标为: <code>${htmlEscape(target)}</code>`, true);
        return;
      }
      
      if (parts.length >= 2 && parts[1].toLowerCase() === "target") {
        const config = await this.getUserConfig(userId);
        await this.safeEditMessage(msg, `📌 当前默认转发目标: <code>${htmlEscape(config.target)}</code>`, true);
        return;
      }
      
      // 处理帮助命令
      if (parts.length === 2 && (parts[1] === 'help' || parts[1] === 'h')) {
        await this.safeEditMessage(msg, help_text, true);
        return;
      }
      
      // 获取用户配置
      const config = await this.getUserConfig(userId);
      let target = config.target;
      const showSource = config.showSource;
      
      // 解析链接和临时目标
      const links: string[] = [];
      let tempTarget: string | null = null;
      let rangeMode = false;
      let rangeInfo: { chatId: string; startId: number; endId: number } | null = null;
      
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        
        // 检查是否是范围模式（包含|）
        if (part.includes('|') && (part.startsWith('http') || part.startsWith('t.me'))) {
          const rangeParts = part.split('|');
          if (rangeParts.length === 2) {
            const link1 = this.parseMessageLink(rangeParts[0]);
            const link2 = this.parseMessageLink(rangeParts[1]);
            
            if (link1 && link2 && link1.chatId === link2.chatId) {
              rangeMode = true;
              rangeInfo = {
                chatId: link1.chatId,
                startId: link1.messageId,
                endId: link2.messageId
              };
              break;
            }
          }
        } else if (part.startsWith('http') || part.startsWith('t.me')) {
          links.push(part);
        } else if (i === parts.length - 1 && links.length > 0) {
          tempTarget = part;
        }
      }
      
      if (tempTarget) target = tempTarget;
      const localTarget = this.isLocalTarget(target);
      
      // 如果既没有链接也没有回复消息，显示帮助
      if (links.length === 0 && !replyMsg && !rangeMode) {
        await this.safeEditMessage(msg, help_text, true);
        return;
      }
      
      // 获取目标对话实体
      let targetPeer: any;
      if (!localTarget) {
        try {
          targetPeer = await client.getInputEntity(target);
        } catch (error) {
          await this.safeEditMessage(msg, `❌ 无法访问目标对话: <code>${htmlEscape(target)}</code>`, true);
          return;
        }
      }
      
      // 范围模式处理
      if (rangeMode && rangeInfo) {
        await this.safeEditMessage(msg, `🔍 进入范围模式: ${rangeInfo.startId}-${rangeInfo.endId}`, true);
        if (localTarget) {
          const result = await this.processMessageRangeToLocal(
            rangeInfo.chatId,
            rangeInfo.startId,
            rangeInfo.endId,
            msg
          );
          const indexInfo = await this.writeLocalSaveIndex(result.savedFiles);
          const directorySummary = this.formatLocalDirectorySummary(result.savedFiles);

          await this.safeEditMessage(
            msg,
            `✅ 范围本地保存完成\n已保存: ${result.saved}\n跳过: ${result.skipped}\n失败: ${result.failed}\n${directorySummary}${indexInfo ? `\n索引: <code>${htmlEscape(indexInfo.relativeIndexPath)}</code>` : ""}\n<i>每个媒体旁已生成同名 .json 来源元数据</i>`,
            true
          );
        } else {
          const result = await this.processMessageRange(
            rangeInfo.chatId,
            rangeInfo.startId,
            rangeInfo.endId,
            targetPeer,
            msg,
            showSource
          );
          
          await this.safeEditMessage(msg, `✅ 范围处理完成\n成功: ${result.success}/${result.total} 条消息`, true);
        }
        return;
      }
      
      // 处理消息
      const messagesToProcess: Array<{
        chatId: string;
        messageId: number;
        groupedId?: string;
        isMediaGroup?: boolean;
      }> = [];
      
      // 链接模式
      if (links.length > 0) {
        for (const link of links) {
          const linkInfo = this.parseMessageLink(link);
          if (!linkInfo) {
            await this.safeEditMessage(msg, `❌ 无效的消息链接: <code>${htmlEscape(link)}</code>`, true);
            return;
          }
          
          const sourceMsg = await this.getMessage(linkInfo.chatId, linkInfo.messageId);
          if (sourceMsg) {
            if (sourceMsg.groupedId) {
              const existingGroup = messagesToProcess.find(m => 
                m.groupedId === sourceMsg.groupedId?.toString()
              );
              if (!existingGroup) {
                messagesToProcess.push({
                  chatId: linkInfo.chatId,
                  messageId: linkInfo.messageId,
                  groupedId: sourceMsg.groupedId?.toString(),
                  isMediaGroup: true
                });
              }
            } else {
              messagesToProcess.push({
                chatId: linkInfo.chatId,
                messageId: linkInfo.messageId
              });
            }
          } else {
            await this.safeEditMessage(msg, `❌ 无法获取消息: ${link}`, true);
            return;
          }
        }
      }
      // 回复模式
      else if (replyMsg) {
        messagesToProcess.push({
          chatId: replyMsg.peerId?.toString() || "",
          messageId: replyMsg.id,
          groupedId: replyMsg.groupedId?.toString()
        });
      }
      
      if (messagesToProcess.length === 0) {
        await this.safeEditMessage(msg, "❌ 未找到要转发的消息", true);
        return;
      }
      
      const total = messagesToProcess.length;
      const mediaGroups = new Map<string, boolean>();
      let successCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      let lastForwardedMsg: Api.Message | undefined;
      const sourceSummaries: Array<{ chatId: string; messageId: number }> = [];
      const localSavedFiles: LocalSavedFile[] = [];
      
      await this.safeEditMessage(msg, localTarget ? `🔄 开始保存 ${total} 个消息/媒体组到本地...` : `🔄 开始处理 ${total} 个消息/媒体组...`, true);
      
      for (let i = 0; i < messagesToProcess.length; i++) {
        const messageInfo = messagesToProcess[i];
        const progress = total > 1 ? `[${i + 1}/${total}] ` : "";
        
        if (messageInfo.isMediaGroup && messageInfo.groupedId) {
          if (mediaGroups.has(messageInfo.groupedId)) continue;
          mediaGroups.set(messageInfo.groupedId, true);
          
          // 简化处理：对于媒体组，逐个消息处理
          const client = await getGlobalClient();
          const peer = await client.getInputEntity(messageInfo.chatId);
          const searchIds: number[] = [];
          
          for (let j = 0; j <= 60; j++) {
            const id = messageInfo.messageId - 30 + j;
            if (id > 0) searchIds.push(id);
          }
          
          const messages = await client.getMessages(peer, { ids: searchIds });
          const groupMessages = messages.filter((msg): msg is Api.Message => 
            msg && (msg as Api.Message).groupedId?.toString() === messageInfo.groupedId
          );
          
          groupMessages.sort((a, b) => a.id - b.id);
          const localGroupDirName = localTarget ? `group_${messageInfo.groupedId}` : undefined;
           
          for (let j = 0; j < groupMessages.length; j++) {
            const groupMsg = groupMessages[j];
            const groupProgress = `[${i + 1}/${total}] [${j + 1}/${groupMessages.length}] `;
            const result = localTarget
              ? await this.processMessageToLocal(groupMsg, msg, messageInfo.chatId, groupMsg.id, groupProgress, {
                  groupDirName: localGroupDirName,
                  quietSuccess: total > 1,
                })
              : await this.processMessage(groupMsg, targetPeer, msg, messageInfo.chatId, groupMsg.id, groupProgress);
            
            if (result.success) {
              successCount++;
              if (!localTarget && result.forwardedMsg) {
                lastForwardedMsg = result.forwardedMsg;
              }
              if (localTarget && result.savedFile) {
                localSavedFiles.push(result.savedFile);
              }
              if (result.source) {
                sourceSummaries.push(result.source);
              }
            } else if (localTarget && result.skipped) {
              skippedCount++;
            } else if (localTarget) {
              failedCount++;
            }
            
            if (j < groupMessages.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        } else {
          const sourceMsg = await this.getMessage(messageInfo.chatId, messageInfo.messageId);
          if (sourceMsg) {
            const result = localTarget
              ? await this.processMessageToLocal(sourceMsg, msg, messageInfo.chatId, messageInfo.messageId, progress, {
                  quietSuccess: total > 1,
                })
              : await this.processMessage(sourceMsg, targetPeer, msg, messageInfo.chatId, messageInfo.messageId, progress);
            if (result.success) {
              successCount++;
              if (!localTarget && result.forwardedMsg) {
                lastForwardedMsg = result.forwardedMsg;
              }
              if (localTarget && result.savedFile) {
                localSavedFiles.push(result.savedFile);
              }
              if (result.source) {
                sourceSummaries.push(result.source);
              }
            } else if (localTarget && result.skipped) {
              skippedCount++;
            } else if (localTarget) {
              failedCount++;
            }
          }
        }
        
        if (i < messagesToProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      if (!localTarget && showSource && lastForwardedMsg && sourceSummaries.length > 0) {
        if (sourceSummaries.length === 1) {
          const source = sourceSummaries[0];
          await this.sendSingleSourceMessage(targetPeer, source.chatId, source.messageId, lastForwardedMsg, total === 1 ? msg : undefined);
        } else {
          await this.sendBatchSourceSummary(targetPeer, lastForwardedMsg, sourceSummaries);
        }
      }

      if (localTarget) {
        const indexInfo = await this.writeLocalSaveIndex(localSavedFiles);
        const directorySummary = this.formatLocalDirectorySummary(localSavedFiles);
        if (localSavedFiles.length === 1) {
          const savedFile = localSavedFiles[0];
          await this.safeEditMessage(
            msg,
            `✅ 本地保存完成\n文件: <code>${htmlEscape(savedFile.relativeFilePath)}</code>\n元数据: <code>${htmlEscape(savedFile.relativeMetadataPath)}</code>\n${directorySummary}${indexInfo ? `\n索引: <code>${htmlEscape(indexInfo.relativeIndexPath)}</code>` : ""}`,
            true
          );
        } else {
          await this.safeEditMessage(
            msg,
            `✅ 本地保存完成\n已保存: ${successCount}\n跳过: ${skippedCount}\n失败: ${failedCount}\n${directorySummary}${indexInfo ? `\n索引: <code>${htmlEscape(indexInfo.relativeIndexPath)}</code>` : ""}\n<i>每个媒体旁已生成同名 .json 来源元数据</i>`,
            true
          );
        }
      } else if (total > 1) {
        await this.safeEditMessage(msg, `✅ 批量处理完成\n成功处理 ${successCount}/${total} 个消息/媒体组`, true);
      }
      
    } catch (error: any) {
      console.error(`save命令执行失败:`, error);
      await this.safeEditMessage(msg, `❌ 执行失败: ${htmlEscape(error.message || "未知错误")}`, true);
    }
  }
  
  cmdHandlers = {
    save: async (msg: Api.Message): Promise<void> => {
      if (!this.db) await this.initDB();
      await this.handleCommand(msg);
    }
  };
}

export default new SavePlugin();
