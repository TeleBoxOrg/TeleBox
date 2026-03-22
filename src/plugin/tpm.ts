import { Plugin, isValidPlugin } from "@utils/pluginBase";
import { loadPlugins } from "@utils/pluginManager";
import {
  createDirectoryInTemp,
  createDirectoryInAssets,
} from "@utils/pathHelpers";
import path from "path";
import fs from "fs";
import axios from "axios";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const MAX_MESSAGE_LENGTH = 4000;
const PLUGINS_INDEX_URL =
  "https://raw.githubusercontent.com/TeleBoxDev/TeleBox_Plugins/main/plugins.json";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_HEADERS = {
  "User-Agent": "TeleBox-TPM/1.0",
  Accept: "application/json, text/plain, */*",
};

interface PluginRecord {
  url: string;
  desc?: string;
  _updatedAt: number;
}

type Database = Record<string, PluginRecord>;
type RemotePluginInfo = { url: string; desc?: string };
type RemotePluginsIndex = Record<string, RemotePluginInfo>;

const PLUGIN_PATH = path.join(process.cwd(), "plugins");

class EntityManager {
  private count = 0;
  private readonly LIMIT = 100;
  private readonly IMPORTANT_TAGS = ['blockquote', 'a', 'b', 'i', 'u'];
  
  canAdd(tag: string): boolean {
    if (this.IMPORTANT_TAGS.includes(tag)) {
      return true;
    }
    return this.count < this.LIMIT;
  }
  
  add(tag: string) {
    this.count++;
  }
  
  getCount(): number {
    return this.count;
  }
  
  hasReachedLimit(): boolean {
    return this.count >= this.LIMIT;
  }
}

async function sendOrEditMessage(
  msg: Api.Message, 
  text: string, 
  options?: { parseMode?: string; linkPreview?: boolean }
): Promise<Api.Message> {
  const messageOptions = {
    text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  try {
    await msg.edit(messageOptions);
    return msg;
  } catch (error) {
    console.log(`[TPM] 编辑消息失败，尝试发送新消息: ${error}`);
  }

  const sendOptions: any = {
    message: text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  if (msg.replyTo?.replyToMsgId) {
    sendOptions.replyTo = msg.replyTo.replyToMsgId;
  }

  const newMsg = await msg.client?.sendMessage(msg.peerId, sendOptions);
  return newMsg || msg;
}

async function updateProgressMessage(
  msg: Api.Message, 
  text: string, 
  options?: { parseMode?: string; linkPreview?: boolean }
): Promise<boolean> {
  const messageOptions = {
    text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  try {
    await msg.edit(messageOptions);
    return true;
  } catch (error) {
    console.log(`[TPM] 编辑进度消息失败，静默继续: ${error}`);
    return false;
  }
}

function splitLongText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const messages: string[] = [];
  const lines = text.split('\n');
  let currentMessage = '';

  for (const line of lines) {
    if (line.length > maxLength) {
      if (currentMessage) {
        messages.push(currentMessage);
        currentMessage = '';
      }
      for (let i = 0; i < line.length; i += maxLength) {
        messages.push(line.substring(i, i + maxLength));
      }
      continue;
    }

    if (currentMessage.length + line.length + 1 > maxLength) {
      messages.push(currentMessage);
      currentMessage = line;
    } else {
      currentMessage += (currentMessage ? '\n' : '') + line;
    }
  }

  if (currentMessage) {
    messages.push(currentMessage);
  }

  return messages;
}

async function sendLongMessage(
  msg: Api.Message,
  text: string,
  options?: { parseMode?: string; linkPreview?: boolean },
  isEdit: boolean = true
): Promise<void> {
  const messages = splitLongText(text);
  
  if (messages.length === 0) {
    return;
  }

  const messageOptions = {
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  if (isEdit) {
    try {
      await msg.edit({
        text: messages[0],
        ...messageOptions,
      });
    } catch (error) {
      await msg.client?.sendMessage(msg.peerId, {
        message: messages[0],
        ...messageOptions,
        replyTo: msg.replyTo?.replyToMsgId,
      });
    }
  } else {
    await msg.client?.sendMessage(msg.peerId, {
      message: messages[0],
      ...messageOptions,
      replyTo: msg.replyTo?.replyToMsgId,
    });
  }

  for (let i = 1; i < messages.length; i++) {
    await msg.reply({
      message: `📋 <b>续 (${i}/${messages.length - 1}):</b>\n\n<blockquote expandable>${messages[i]}</blockquote>`,
      ...messageOptions,
    });
  }
}

async function getDatabase() {
  const filePath = path.join(createDirectoryInAssets("tpm"), "plugins.json");
  const db = await JSONFilePreset<Database>(filePath, {});
  return db;
}

async function getMediaFileName(msg: any): Promise<string> {
  const metadata = msg.media as any;
  return metadata.document.attributes[0].fileName;
}

function normalizeGithubUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 5 && parts[2] === "blob") {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
      }
      return input;
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      parsed.search = "";
      return parsed.toString();
    }
    return input;
  } catch {
    return input;
  }
}

function getRetryDelayMs(error: unknown, attempt: number): number {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 429) {
      const retryAfter = error.response?.headers?.["retry-after"];
      if (typeof retryAfter === "string") {
        const seconds = Number.parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) {
          return Math.max(0, seconds * 1000);
        }
        const date = Date.parse(retryAfter);
        if (!Number.isNaN(date)) {
          return Math.max(0, date - Date.now());
        }
      }
    }
  }
  const base = 600 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function fetchWithRetry<T>(
  url: string,
  options?: Parameters<typeof axios.get>[1]
) {
  let lastError: unknown;
  const normalizedUrl = normalizeGithubUrl(url);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.get<T>(normalizedUrl, {
        timeout: REQUEST_TIMEOUT_MS,
        ...options,
        headers: {
          ...DEFAULT_HEADERS,
          ...(options?.headers || {}),
        },
      });
    } catch (error) {
      lastError = error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (!status || !RETRYABLE_STATUS.has(status) || attempt === MAX_RETRIES) {
        throw error;
      }
      const delay = getRetryDelayMs(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function installRemotePlugin(plugin: string, msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, `正在安装插件 ${plugin}...`);
  const res = await fetchWithRetry<RemotePluginsIndex>(PLUGINS_INDEX_URL);
  if (res.status === 200) {
    if (!res.data[plugin]) {
      await sendOrEditMessage(statusMsg, `未找到插件 ${plugin} 的远程资源`);
      return;
    }
    const pluginUrl = normalizeGithubUrl(res.data[plugin].url);
    const response = await fetchWithRetry<string>(pluginUrl, {
      responseType: "text",
    });
    if (response.status !== 200) {
      await sendOrEditMessage(statusMsg, `无法下载插件 ${plugin}`);
      return;
    }
    const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
    const oldBackupPath = path.join(PLUGIN_PATH, `${plugin}.ts.backup`);

    if (fs.existsSync(filePath)) {
      const cacheDir = createDirectoryInTemp("plugin_backups");
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, -5);
      const backupPath = path.join(cacheDir, `${plugin}_${timestamp}.ts`);
      fs.copyFileSync(filePath, backupPath);
      console.log(`[TPM] 旧插件已转移到缓存: ${backupPath}`);
    }

    if (fs.existsSync(oldBackupPath)) {
      fs.unlinkSync(oldBackupPath);
      console.log(`[TPM] 已清理旧备份文件: ${oldBackupPath}`);
    }

    fs.writeFileSync(filePath, response.data);

    try {
      const db = await getDatabase();
      db.data[plugin] = { ...res.data[plugin], _updatedAt: Date.now() };
      await db.write();
      console.log(`[TPM] 已记录插件信息到数据库: ${plugin}`);
    } catch (error) {
      console.error(`[TPM] 记录插件信息失败: ${error}`);
    }

    await sendOrEditMessage(statusMsg, `插件 ${plugin} 已安装并加载成功`);
    await loadPlugins();
  } else {
    await sendOrEditMessage(statusMsg, `无法获取远程插件库`);
  }
}

async function installAllPlugins(msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, "🔍 正在获取远程插件列表...");
  try {
    const res = await fetchWithRetry<RemotePluginsIndex>(PLUGINS_INDEX_URL);
    if (res.status !== 200) {
      await sendOrEditMessage(statusMsg, "❌ 无法获取远程插件库");
      return;
    }

    const plugins = Object.keys(res.data);
    const totalPlugins = plugins.length;
    if (totalPlugins === 0) {
      await sendOrEditMessage(statusMsg, "📦 远程插件库为空");
      return;
    }

    let installedCount = 0;
    let failedCount = 0;
    const failedPlugins: string[] = [];

    await sendOrEditMessage(statusMsg, `📦 开始安装 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`, { parseMode: "html" });

    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = generateProgressBar(progress);
      try {
        if ([0, plugins.length - 1].includes(i) || i % 2 === 0) {
          await sendOrEditMessage(statusMsg, `📦 正在安装插件: <code>${plugin}</code>\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${installedCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        const pluginData = res.data[plugin];
        if (!pluginData || !pluginData.url) {
          failedCount++;
          failedPlugins.push(`${plugin} (无URL)`);
          continue;
        }

        const pluginUrl = normalizeGithubUrl(pluginData.url);
        const response = await fetchWithRetry<string>(pluginUrl, {
          responseType: "text",
        });
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${plugin} (下载失败)`);
          continue;
        }

        const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
        const oldBackupPath = path.join(PLUGIN_PATH, `${plugin}.ts.backup`);

        if (fs.existsSync(filePath)) {
          const cacheDir = createDirectoryInTemp("plugin_backups");
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, -5);
          const backupPath = path.join(cacheDir, `${plugin}_${timestamp}.ts`);
          fs.copyFileSync(filePath, backupPath);
          console.log(`[TPM] 旧插件已转移到缓存: ${backupPath}`);
        }
        if (fs.existsSync(oldBackupPath)) {
          fs.unlinkSync(oldBackupPath);
          console.log(`[TPM] 已清理旧备份文件: ${oldBackupPath}`);
        }

        fs.writeFileSync(filePath, response.data);

        try {
          const db = await getDatabase();
          db.data[plugin] = {
            url: pluginUrl,
            desc: pluginData.desc,
            _updatedAt: Date.now(),
          };
          await db.write();
          console.log(`[TPM] 已记录插件信息到数据库: ${plugin}`);
        } catch (dbError) {
          console.error(`[TPM] 记录插件信息失败: ${dbError}`);
        }

        installedCount++;
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${plugin} (${error})`);
        console.error(`[TPM] 安装插件 ${plugin} 失败:`, error);
      }
    }

    try {
      await loadPlugins();
    } catch (error) {
      console.error("[TPM] 重新加载插件失败:", error);
    }

    const successBar = generateProgressBar(100);
    let resultMsg = `🎉 <b>批量安装完成!</b>\n\n${successBar}\n\n📊 <b>安装统计:</b>\n✅ 成功安装: ${installedCount}/${totalPlugins}\n❌ 安装失败: ${failedCount}/${totalPlugins}`;
    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).join("\n• ");
      const moreFailures =
        failedPlugins.length > 5
          ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败`
          : "";
      resultMsg += `\n\n❌ <b>失败列表:</b>\n• ${failedList}${moreFailures}`;
    }
    resultMsg += `\n\n🔄 插件已重新加载，可以开始使用!`;

    await sendOrEditMessage(statusMsg, resultMsg, { parseMode: "html" });
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 批量安装失败: ${error}`);
    console.error("[TPM] 批量安装插件失败:", error);
  }
}

async function installMultiplePlugins(pluginNames: string[], msg: Api.Message) {
  const totalPlugins = pluginNames.length;
  if (totalPlugins === 0) {
    await sendOrEditMessage(msg, "❌ 未提供要安装的插件名称");
    return;
  }

  const statusMsg = await sendOrEditMessage(msg, `🔍 正在获取远程插件列表...`, { parseMode: "html" });

  try {
    const res = await fetchWithRetry<RemotePluginsIndex>(PLUGINS_INDEX_URL);
    if (res.status !== 200) {
      await sendOrEditMessage(statusMsg, "❌ 无法获取远程插件库");
      return;
    }

    let installedCount = 0;
    let failedCount = 0;
    const failedPlugins: string[] = [];
    const notFoundPlugins: string[] = [];

    await sendOrEditMessage(statusMsg, `📦 开始安装 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`, { parseMode: "html" });

    for (let i = 0; i < pluginNames.length; i++) {
      const pluginName = pluginNames[i];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = generateProgressBar(progress);

      try {
        if ([0, pluginNames.length - 1].includes(i) || i % 2 === 0) {
          await sendOrEditMessage(statusMsg, `📦 正在安装插件: <code>${pluginName}</code>\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${installedCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        if (!res.data[pluginName]) {
          failedCount++;
          notFoundPlugins.push(pluginName);
          continue;
        }

        const pluginData = res.data[pluginName];
        if (!pluginData.url) {
          failedCount++;
          failedPlugins.push(`${pluginName} (无URL)`);
          continue;
        }

        const pluginUrl = normalizeGithubUrl(pluginData.url);
        const response = await fetchWithRetry<string>(pluginUrl, {
          responseType: "text",
        });
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${pluginName} (下载失败)`);
          continue;
        }

        const filePath = path.join(PLUGIN_PATH, `${pluginName}.ts`);
        const oldBackupPath = path.join(PLUGIN_PATH, `${pluginName}.ts.backup`);

        if (fs.existsSync(filePath)) {
          const cacheDir = createDirectoryInTemp("plugin_backups");
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, -5);
          const backupPath = path.join(
            cacheDir,
            `${pluginName}_${timestamp}.ts`
          );
          fs.copyFileSync(filePath, backupPath);
          console.log(`[TPM] 旧插件已转移到缓存: ${backupPath}`);
        }

        if (fs.existsSync(oldBackupPath)) {
          fs.unlinkSync(oldBackupPath);
          console.log(`[TPM] 已清理旧备份文件: ${oldBackupPath}`);
        }

        fs.writeFileSync(filePath, response.data);

        try {
          const db = await getDatabase();
          db.data[pluginName] = {
            url: pluginUrl,
            desc: pluginData.desc,
            _updatedAt: Date.now(),
          };
          await db.write();
          console.log(`[TPM] 已记录插件信息到数据库: ${pluginName}`);
        } catch (dbError) {
          console.error(`[TPM] 记录插件信息失败: ${dbError}`);
        }

        installedCount++;
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${pluginName} (${error})`);
        console.error(`[TPM] 安装插件 ${pluginName} 失败:`, error);
      }
    }

    try {
      await loadPlugins();
    } catch (error) {
      console.error("[TPM] 重新加载插件失败:", error);
    }

    const successBar = generateProgressBar(100);
    let resultMsg = `🎉 <b>批量安装完成!</b>\n\n${successBar}\n\n📊 <b>安装统计:</b>\n✅ 成功安装: ${installedCount}/${totalPlugins}\n❌ 安装失败: ${failedCount}/${totalPlugins}`;

    if (notFoundPlugins.length > 0) {
      const notFoundList = notFoundPlugins.slice(0, 5).join("\n• ");
      const moreNotFound =
        notFoundPlugins.length > 5
          ? `\n• ... 还有 ${notFoundPlugins.length - 5} 个未找到`
          : "";
      resultMsg += `\n\n🔍 <b>未找到的插件:</b>\n• ${notFoundList}${moreNotFound}`;
    }

    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).join("\n• ");
      const moreFailures =
        failedPlugins.length > 5
          ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败`
          : "";
      resultMsg += `\n\n❌ <b>其他失败:</b>\n• ${failedList}${moreFailures}`;
    }

    resultMsg += `\n\n🔄 插件已重新加载，可以开始使用!`;

    await sendOrEditMessage(statusMsg, resultMsg, { parseMode: "html" });
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 批量安装失败: ${error}`);
    console.error("[TPM] 批量安装插件失败:", error);
  }
}

function generateProgressBar(percentage: number, length: number = 20): string {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `🔄 当前进度: [${bar}] ${percentage}%`;
}

async function installPlugin(args: string[], msg: Api.Message) {
  if (args.length === 1) {
    if (msg.isReply) {
      const replied = await msg.getReplyMessage();
      if (replied?.media) {
        const fileName = await getMediaFileName(replied);
        
        if (!fileName.endsWith(".ts")) {
          await sendOrEditMessage(msg, `❌ 文件格式错误\n文件不是有效插件`);
          return;
        }
        
        const pluginName = fileName.replace(".ts", "");
        const statusMsg = await sendOrEditMessage(msg, `🔍 正在验证插件 ${pluginName} ...`);
        const filePath = path.join(PLUGIN_PATH, fileName);

        await msg.client?.downloadMedia(replied, { outputFile: filePath });
        
        try {
          const pluginModule = require(filePath);
          const pluginInstance = pluginModule.default || pluginModule;
          
          if (!isValidPlugin(pluginInstance)) {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            await sendOrEditMessage(statusMsg, `❌ 插件验证失败\n文件不是有效插件`);
            return;
          }
        } catch (error) {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          await sendOrEditMessage(statusMsg, `❌ 插件加载失败\n错误信息:\n${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        await sendOrEditMessage(statusMsg, `✅ 验证通过，正在安装插件 ${pluginName} ...`);

        let overrideMessage = "";
        try {
          const db = await getDatabase();
          if (db.data[pluginName]) {
            delete db.data[pluginName];
            await db.write();
            overrideMessage = `\n⚠️ 已覆盖之前已安装的远程插件\n若需保持更新, 请 <code>${mainPrefix}tpm i ${pluginName}</code>`;
            console.log(`[TPM] 已从数据库中清除同名插件记录: ${pluginName}`);
          }
        } catch (error) {
          console.error(`[TPM] 清除数据库记录失败: ${error}`);
        }

        await loadPlugins();
        await sendOrEditMessage(statusMsg, `✅ 插件 ${pluginName} 已安装并加载成功${overrideMessage}`, { parseMode: "html" });
      } else {
        await sendOrEditMessage(msg, "请回复一个插件文件");
      }
    } else {
      await sendOrEditMessage(msg, "请回复某个插件文件或提供 tpm 包名");
    }
  } else {
    const pluginNames = args.slice(1);

    if (pluginNames.length === 1 && pluginNames[0] === "all") {
      await installAllPlugins(msg);
    } else if (pluginNames.length === 1) {
      await installRemotePlugin(pluginNames[0], msg);
    } else {
      await installMultiplePlugins(pluginNames, msg);
    }
  }
}

async function uninstallPlugin(plugin: string, msg: Api.Message) {
  if (!plugin) {
    await sendOrEditMessage(msg, "请提供要卸载的插件名称");
    return;
  }
  const statusMsg = await sendOrEditMessage(msg, `正在卸载插件 ${plugin}...`);
  const pluginPath = path.join(PLUGIN_PATH, `${plugin}.ts`);
  if (fs.existsSync(pluginPath)) {
    fs.unlinkSync(pluginPath);
    try {
      const db = await getDatabase();
      if (db.data[plugin]) {
        delete db.data[plugin];
        await db.write();
        console.log(`[TPM] 已从数据库中删除插件记录: ${plugin}`);
      }
    } catch (error) {
      console.error(`[TPM] 删除插件数据库记录失败: ${error}`);
    }
    await sendOrEditMessage(statusMsg, `插件 ${plugin} 已卸载`);
  } else {
    await sendOrEditMessage(statusMsg, `未找到插件 ${plugin}`);
  }
  await loadPlugins();
}

async function uninstallMultiplePlugins(
  pluginNames: string[],
  msg: Api.Message
) {
  if (!pluginNames || pluginNames.length === 0) {
    await sendOrEditMessage(msg, "请提供要卸载的插件名称");
    return;
  }

  const results: { name: string; success: boolean; reason?: string }[] = [];
  let processedCount = 0;
  const totalCount = pluginNames.length;

  const statusMsg = await sendOrEditMessage(msg, `开始卸载 ${totalCount} 个插件...\n${generateProgressBar(
      0
    )} 0/${totalCount}`);

  try {
    const db = await getDatabase();

    for (const pluginName of pluginNames) {
      const trimmedName = pluginName.trim();
      if (!trimmedName) {
        results.push({
          name: pluginName,
          success: false,
          reason: "插件名称为空",
        });
        processedCount++;
        continue;
      }

      const pluginPath = path.join(PLUGIN_PATH, `${trimmedName}.ts`);

      if (fs.existsSync(pluginPath)) {
        try {
          fs.unlinkSync(pluginPath);
          if (db.data[trimmedName]) {
            delete db.data[trimmedName];
            console.log(`[TPM] 已从数据库中删除插件记录: ${trimmedName}`);
          }
          results.push({ name: trimmedName, success: true });
        } catch (error) {
          console.error(`[TPM] 卸载插件 ${trimmedName} 失败:`, error);
          results.push({
            name: trimmedName,
            success: false,
            reason: `删除失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      } else {
        results.push({
          name: trimmedName,
          success: false,
          reason: "插件不存在",
        });
      }

      processedCount++;
      const percentage = Math.round((processedCount / totalCount) * 100);

      await sendOrEditMessage(statusMsg, `卸载插件中...\n${generateProgressBar(
          percentage
        )} ${processedCount}/${totalCount}\n当前: ${trimmedName}`);
    }

    await db.write();
  } catch (error) {
    console.error(`[TPM] 批量卸载过程中发生错误:`, error);
    await sendOrEditMessage(msg, `批量卸载过程中发生错误: ${
        error instanceof Error ? error.message : String(error)
      }`);
    return;
  }

  await loadPlugins();

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;

  let resultText = `\n📊 卸载完成\n\n`;
  resultText += `✅ 成功: ${successCount}\n`;
  resultText += `❌ 失败: ${failedCount}\n\n`;

  if (successCount > 0) {
    const successPlugins = results.filter((r) => r.success).map((r) => r.name);
    resultText += `✅ 已卸载:\n${successPlugins
      .map((name) => `  • ${name}`)
      .join("\n")}\n\n`;
  }

  if (failedCount > 0) {
    const failedPlugins = results.filter((r) => !r.success);
    resultText += `❌ 卸载失败:\n${failedPlugins
      .map((r) => `  • ${r.name}: ${r.reason}`)
      .join("\n")}`;
  }

  await sendOrEditMessage(statusMsg, resultText);
}

async function uninstallAllPlugins(msg: Api.Message) {
  try {
    const statusMsg = await sendOrEditMessage(msg, "⚠️ 正在清空插件目录并刷新缓存...");

    let removed = 0;
    let failed: string[] = [];

    try {
      if (fs.existsSync(PLUGIN_PATH)) {
        const files = fs.readdirSync(PLUGIN_PATH);
        for (const file of files) {
          const full = path.join(PLUGIN_PATH, file);
          const isPluginTs =
            file.endsWith(".ts") &&
            !file.includes("backup") &&
            !file.endsWith(".d.ts") &&
            !file.startsWith("_");
          if (!isPluginTs) continue;
          try {
            fs.unlinkSync(full);
            removed++;
          } catch (e) {
            failed.push(file);
          }
        }
      }
    } catch (e) {
      console.error("[TPM] 扫描插件目录失败:", e);
    }

    try {
      const db = await getDatabase();
      for (const k of Object.keys(db.data)) delete db.data[k];
      await db.write();
    } catch (e) {
      console.error("[TPM] 清空数据库失败:", e);
    }

    try {
      await loadPlugins();
    } catch (e) {
      console.error("[TPM] 重新加载插件失败:", e);
    }

    let text = `✅ 已清空插件目录并刷新缓存\n\n🗑 删除文件: ${removed}`;
    if (failed.length) {
      const show = failed.slice(0, 10).join("\n• ");
      text += `\n❌ 删除失败: ${failed.length}\n• ${show}${
        failed.length > 10 ? `\n• ... 还有 ${failed.length - 10} 个失败` : ""
      }`;
    }
    await sendOrEditMessage(statusMsg, text, { parseMode: "html" });
  } catch (error) {
    console.error("[TPM] 清空插件目录失败:", error);
    await sendOrEditMessage(msg, `❌ 清空插件目录失败: ${error}`);
  }
}

async function uploadPlugin(args: string[], msg: Api.Message) {
  const pluginName = args[1];
  if (!pluginName) {
    await sendOrEditMessage(msg, "请提供插件名称");
    return;
  }
  const pluginPath = path.join(PLUGIN_PATH, `${pluginName}.ts`);
  if (!fs.existsSync(pluginPath)) {
    await sendOrEditMessage(msg, `未找到插件 ${pluginName}`);
    return;
  }
  
  const statusMsg = await sendOrEditMessage(msg, `正在上传插件 ${pluginName}...`);
  
  const sendOptions: any = {
    file: pluginPath,
    thumb: path.join(process.cwd(), "telebox.png"),
    caption: `**TeleBox_Plugin ${pluginName} plugin.**`,
  };

  if (msg.replyTo?.replyToMsgId) {
    sendOptions.replyTo = msg.replyTo.replyToMsgId;
  }

  await msg.client?.sendFile(msg.peerId, sendOptions);
  
  if (statusMsg.id !== msg.id) {
    await statusMsg.delete();
  } else {
    await msg.delete();
  }
}

async function search(msg: Api.Message) {
  const text = msg.message;
  const parts = text.trim().split(/\s+/);
  const keyword = parts.length > 2 ? parts[2].toLowerCase() : "";
  
  try {
    const statusMsg = await sendOrEditMessage(msg, keyword ? `🔍 正在搜索插件: ${keyword}` : "🔍 正在获取插件列表...");
    const res = await fetchWithRetry<RemotePluginsIndex>(PLUGINS_INDEX_URL, {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    if (res.status !== 200) {
      await sendOrEditMessage(statusMsg, `❌ 无法获取远程插件库`);
      return;
    }
    const remotePlugins = res.data;
    const pluginNames = Object.keys(remotePlugins);

    const localPlugins = new Set<string>();
    try {
      if (fs.existsSync(PLUGIN_PATH)) {
        const files = fs.readdirSync(PLUGIN_PATH);
        files.forEach((file) => {
          if (file.endsWith(".ts") && !file.includes("backup")) {
            localPlugins.add(file.replace(".ts", ""));
          }
        });
      }
    } catch (error) {
      console.error("[TPM] 读取本地插件失败:", error);
    }

    const db = await getDatabase();
    const dbPlugins = db.data;

    const filteredPlugins = keyword 
      ? pluginNames.filter(name => {
          const pluginData = remotePlugins[name];
          const nameMatch = name.toLowerCase().includes(keyword);
          const descMatch = pluginData?.desc?.toLowerCase().includes(keyword) || false;
          return nameMatch || descMatch;
        })
      : pluginNames;
    
    const totalPlugins = filteredPlugins.length;
    
    if (totalPlugins === 0 && keyword) {
      await sendOrEditMessage(statusMsg, `🔍 未找到包含 "<b>${keyword}</b>" 的插件`, { parseMode: "html" });
      return;
    }

    let installedCount = 0;
    let localOnlyCount = 0;
    let notInstalledCount = 0;

    const entityMgr = new EntityManager();
    
    // 预留重要标签的位置
    entityMgr.add('b'); // 标题
    entityMgr.add('b'); // 统计标题
    entityMgr.add('b'); // 搜索关键词
    entityMgr.add('b'); // 搜索结果标题
    entityMgr.add('blockquote'); // 插件列表
    entityMgr.add('b'); // 快捷操作标题
    entityMgr.add('code'); // 第一个命令
    entityMgr.add('code'); // 第二个命令
    entityMgr.add('code'); // 第三个命令
    entityMgr.add('code'); // 第四个命令
    entityMgr.add('code'); // 第五个命令
    entityMgr.add('code'); // 第六个命令
    entityMgr.add('b'); // 仓库标题

    const highlightMatch = (text: string) => {
      if (!keyword) return text;
      const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      return text.replace(regex, '<b>$1</b>');
    };

    function getPluginStatus(pluginName: string, remoteUrl: string) {
      const hasLocal = localPlugins.has(pluginName);
      const dbRecord = dbPlugins[pluginName];

      if (hasLocal && dbRecord && dbRecord.url === remoteUrl) {
        installedCount++;
        return { status: "✅", label: "已安装" } as const;
      } else if (hasLocal && !dbRecord) {
        localOnlyCount++;
        return { status: "🔶", label: "本地同名" } as const;
      } else {
        notInstalledCount++;
        return { status: "❌", label: "未安装" } as const;
      }
    }

    const pluginLines: string[] = [];
    for (const plugin of filteredPlugins) {
      const pluginData = remotePlugins[plugin];
      const remoteUrl = pluginData?.url || "";
      const { status } = getPluginStatus(plugin, remoteUrl);
      const description = pluginData?.desc || "暂无描述";
      
      const highlightedName = highlightMatch(plugin);
      const highlightedDesc = highlightMatch(description);
      
      const allowCodeTag = entityMgr.canAdd('code');
      const nameTag = allowCodeTag ? `<code>${highlightedName}</code>` : highlightedName;
      
      pluginLines.push(`${status} ${nameTag} - ${highlightedDesc}`);
      
      if (allowCodeTag) {
        entityMgr.add('code');
      }
      
      if (keyword) {
        entityMgr.add('b');
      }
    }

    let statsInfo = `📊 <b>插件统计:</b>\n`;
    if (keyword) {
      statsInfo += `• 搜索关键词: "<b>${keyword}</b>"\n`;
    }
    statsInfo += `• 总计: ${totalPlugins} 个插件\n`;
    statsInfo += `• ✅ 已安装: ${installedCount} 个\n`;
    statsInfo += `• 🔶 本地同名: ${localOnlyCount} 个\n`;
    statsInfo += `• ❌ 未安装: ${notInstalledCount} 个`;

    const installTip = `\n💡 <b>快捷操作:</b>\n` +
      `• <code>${mainPrefix}tpm i &lt;名称 [名称2 ...]&gt;</code> 安装/批量安装\n` +
      `• <code>${mainPrefix}tpm i all</code> 全部安装\n` +
      `• <code>${mainPrefix}tpm update</code> 更新已装\n` +
      `• <code>${mainPrefix}tpm ls</code> 查看记录\n` +
      `• <code>${mainPrefix}tpm rm &lt;名称&gt;</code> 卸载\n` +
      `• <code>${mainPrefix}tpm rm all</code> 清空`;

    const repoLink = `\n🔗 <b>插件仓库:</b> <a href="https://github.com/TeleBoxDev/TeleBox_Plugins">TeleBox_Plugins</a>`;

    const title = keyword ? `🔍 搜索 "${keyword}" 结果` : `🔍 远程插件列表`;
    const fullMessage = [
      `${title}`,
      `━━━━━━━━━━━━━━━━━`,
      "",
      statsInfo,
      "",
      keyword ? `📦 <b>搜索结果:</b>` : `📦 <b>插件详情:</b>`,
      `<blockquote expandable>${pluginLines.join("\n")}</blockquote>`,
      installTip,
      repoLink
    ].join("\n");

    await sendLongMessage(statusMsg, fullMessage, { parseMode: "html", linkPreview: false }, true);
  } catch (error) {
    console.error("[TPM] 搜索插件失败:", error);
    await sendOrEditMessage(msg, `❌ 搜索插件失败: ${error}`);
  }
}

async function showPluginRecords(msg: Api.Message, verbose?: boolean) {
  try {
    const statusMsg = await sendOrEditMessage(msg, "📚 正在读取插件数据...");
    const db = await getDatabase();
    const dbNames = Object.keys(db.data);

    let filePlugins: string[] = [];
    try {
      if (fs.existsSync(PLUGIN_PATH)) {
        filePlugins = fs
          .readdirSync(PLUGIN_PATH)
          .filter(
            (f) =>
              f.endsWith(".ts") &&
              !f.includes("backup") &&
              !f.endsWith(".d.ts") &&
              !f.startsWith("_")
          )
          .map((f) => f.replace(/\.ts$/, ""));
      }
    } catch (err) {
      console.error("[TPM] 读取本地插件目录失败:", err);
    }

    const notInDb = filePlugins.filter((n) => !dbNames.includes(n));

    const sortedPlugins = dbNames
      .map((name) => ({ name, ...db.data[name] }))
      .sort((a, b) => a._updatedAt - b._updatedAt);

    const entityMgr = new EntityManager();
    
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('blockquote');
    entityMgr.add('blockquote');

    const dbLinesSimple: string[] = [];
    const dbLinesVerbose: string[] = [];
    
    for (const p of sortedPlugins) {
      const allowCodeTag = entityMgr.canAdd('code');
      
      if (verbose) {
        const updateTime = new Date(p._updatedAt).toLocaleString("zh-CN");
        const desc = p.desc ? `\n📝 ${p.desc}` : "";
        const nameTag = allowCodeTag ? `<code>${p.name}</code>` : p.name;
        const urlTag = allowCodeTag ? `<code>${p.url}</code>` : p.url;
        dbLinesVerbose.push(`${nameTag} 🕒 ${updateTime}${desc}\n🔗 ${urlTag}`);
        
        if (allowCodeTag) {
          entityMgr.add('code');
          entityMgr.add('code');
        }
      } else {
        const nameTag = allowCodeTag ? `<code>${p.name}</code>` : p.name;
        dbLinesSimple.push(`${nameTag}${p.desc ? ` - ${p.desc}` : ""}`);
        
        if (allowCodeTag) {
          entityMgr.add('code');
        }
      }
    }

    const localLinesSimple: string[] = [];
    const localLinesVerbose: string[] = [];
    
    for (const name of notInDb) {
      const allowCodeTag = entityMgr.canAdd('code');
      const nameTag = allowCodeTag ? `<code>${name}</code>` : name;
      
      if (verbose) {
        const filePath = path.join(PLUGIN_PATH, `${name}.ts`);
        let mtime = "未知";
        try {
          const stat = fs.statSync(filePath);
          mtime = stat.mtime.toLocaleString("zh-CN");
        } catch {}
        localLinesVerbose.push(`${nameTag} 🗄 ${mtime}`);
      } else {
        localLinesSimple.push(nameTag);
      }
      
      if (allowCodeTag) {
        entityMgr.add('code');
      }
    }

    const tip = verbose
      ? ""
      : `💡 可使用 <code>${mainPrefix}tpm ls -v</code> 查看详情信息`;

    const dbLines = verbose ? dbLinesVerbose : dbLinesSimple;
    const localLines = verbose ? localLinesVerbose : localLinesSimple;

    const messageParts: string[] = [];
    
    messageParts.push(`📚 <b>插件记录</b>`);
    messageParts.push(`━━━━━━━━━━━━━━━━━`);
    
    if (tip) {
      messageParts.push("", tip);
      entityMgr.add('code');
    }
    
    if (dbNames.length > 0) {
      messageParts.push("", `📦 <b>远程插件记录 (${dbNames.length}个):</b>`);
      messageParts.push(`<blockquote expandable>${dbLines.join("\n")}</blockquote>`);
    } else {
      messageParts.push("", `📦 <b>远程插件记录:</b> (空)`);
    }
    
    if (notInDb.length > 0) {
      messageParts.push("", `🗂 <b>本地插件 (${notInDb.length}个):</b>`);
      messageParts.push(`<blockquote expandable>${localLines.join("\n")}</blockquote>`);
    }
    
    messageParts.push("", `━━━━━━━━━━━━━━━━━`);
    messageParts.push(`📊 总计: ${dbNames.length + notInDb.length} 个插件`);
    
    const fullMessage = messageParts.join("\n");
    
    await sendLongMessage(statusMsg, fullMessage, { parseMode: "html", linkPreview: false }, true);
  } catch (error) {
    console.error("[TPM] 读取插件数据库失败:", error);
    await sendOrEditMessage(msg, `❌ 读取数据库失败: ${error}`);
  }
}

async function updateAllPlugins(msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, "🔍 正在检查待更新的插件...");
  let canEdit = true;
  
  try {
    const db = await getDatabase();
    const dbPlugins = Object.keys(db.data);

    if (dbPlugins.length === 0) {
      await sendOrEditMessage(statusMsg, "📦 数据库中没有已安装的插件记录");
      return;
    }

    const totalPlugins = dbPlugins.length;
    let updatedCount = 0;
    let failedCount = 0;
    let skipCount = 0;
    const failedPlugins: string[] = [];

    if (canEdit) {
      canEdit = await updateProgressMessage(statusMsg, `📦 开始更新 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`, { parseMode: "html" });
    }

    for (let i = 0; i < dbPlugins.length; i++) {
      const pluginName = dbPlugins[i];
      const pluginRecord = db.data[pluginName];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = generateProgressBar(progress);

      try {
        if (canEdit && ([0, dbPlugins.length - 1].includes(i) || i % 2 === 0)) {
          canEdit = await updateProgressMessage(statusMsg, `📦 正在更新插件: <code>${pluginName}</code>\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${updatedCount}\n⏭️ 跳过: ${skipCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        if (!pluginRecord.url) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 无URL记录`);
          continue;
        }

        const response = await fetchWithRetry<string>(
          normalizeGithubUrl(pluginRecord.url),
          { responseType: "text" }
        );
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${pluginName} (下载失败)`);
          continue;
        }

        const filePath = path.join(PLUGIN_PATH, `${pluginName}.ts`);

        if (!fs.existsSync(filePath)) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 本地文件不存在`);
          continue;
        }

        const currentContent = fs.readFileSync(filePath, "utf8");
        if (currentContent === response.data) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 内容无变化`);
          continue;
        }

        const cacheDir = createDirectoryInTemp("plugin_backups");
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, -5);
        const backupPath = path.join(cacheDir, `${pluginName}_${timestamp}.ts`);
        fs.copyFileSync(filePath, backupPath);
        console.log(`[TPM] 旧版本已备份到: ${backupPath}`);

        fs.writeFileSync(filePath, response.data);

        try {
          db.data[pluginName]._updatedAt = Date.now();
          await db.write();
          console.log(`[TPM] 已更新插件数据库记录: ${pluginName}`);
        } catch (dbError) {
          console.error(`[TPM] 更新插件数据库记录失败: ${dbError}`);
        }

        updatedCount++;
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${pluginName} (${error})`);
        console.error(`[TPM] 更新插件 ${pluginName} 失败:`, error);
      }
    }

    try {
      await loadPlugins();
    } catch (error) {
      console.error("[TPM] 重新加载插件失败:", error);
    }

    try {
      await statusMsg.delete();
      console.log(`[TPM] 更新完成。统计: 成功${updatedCount}个, 跳过${skipCount}个, 失败${failedCount}个`);
    } catch (error) {
      console.log(`[TPM] 删除状态消息失败: ${error}`);
      try {
        await statusMsg.edit({ 
          text: `✅ 更新完成 (成功${updatedCount}个, 跳过${skipCount}个, 失败${failedCount}个)`, 
          parseMode: "html" 
        });
      } catch (editError) {
        console.log(`[TPM] 最终编辑也失败: ${editError}`);
      }
    }
  } catch (error) {
    console.error("[TPM] 一键更新失败:", error);
    try {
      await statusMsg.delete();
    } catch (deleteError) {
      try {
        await statusMsg.edit({ text: `❌ 一键更新失败: ${error}`, parseMode: "html" });
      } catch (editError) {
        console.log(`[TPM] 错误消息编辑失败: ${editError}`);
      }
    }
  }
}

class TpmPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `<b>📦 TeleBox 插件管理器 (TPM)</b>

<b>🔍 查看插件:</b>
• <code>${mainPrefix}tpm search</code> (别名: <code>s</code>) - 显示远程插件列表
• <code>${mainPrefix}tpm ls</code> (别名: <code>list</code>) - 查看已安装记录
• <code>${mainPrefix}tpm ls -v</code> 或 <code>${mainPrefix}tpm lv</code> - 查看详细记录

<b>⬇️ 安装插件:</b>
• <code>${mainPrefix}tpm i &lt;插件名&gt;</code> (别名: <code>install</code>) - 安装单个插件
• <code>${mainPrefix}tpm i &lt;插件名1&gt; &lt;插件名2&gt;</code> - 安装多个插件
• <code>${mainPrefix}tpm i all</code> - 一键安装全部远程插件
• <code>${mainPrefix}tpm i</code> (回复插件文件) - 安装本地插件文件

<b>🔄 更新插件:</b>
• <code>${mainPrefix}tpm update</code> (别名: <code>updateAll</code>, <code>ua</code>) - 一键更新所有已安装的远程插件

<b>🗑️ 卸载插件:</b>
• <code>${mainPrefix}tpm rm &lt;插件名&gt;</code> (别名: <code>remove</code>, <code>uninstall</code>, <code>un</code>) - 卸载单个插件
• <code>${mainPrefix}tpm rm &lt;插件名1&gt; &lt;插件名2&gt;</code> - 卸载多个插件
• <code>${mainPrefix}tpm rm all</code> - 清空插件目录并刷新本地缓存

<b>⬆️ 上传插件:</b>
• <code>${mainPrefix}tpm upload &lt;插件名&gt;</code> (别名: <code>ul</code>) - 上传指定插件文件`;

  ignoreEdited: boolean = true;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    tpm: async (msg) => {
      const text = msg.message;
      const [, ...args] = text.split(" ");
      if (args.length === 0) {
        await sendOrEditMessage(msg, this.description, { parseMode: "html" });
        return;
      }
      const cmd = args[0];
      if (cmd === "install" || cmd === "i") {
        await installPlugin(args, msg);
      } else if (
        cmd === "uninstall" ||
        cmd == "un" ||
        cmd === "remove" ||
        cmd === "rm"
      ) {
        const pluginNames = args.slice(1);
        if (pluginNames.length === 0) {
          await msg.edit({ text: "请提供要卸载的插件名称" });
        } else if (pluginNames.length === 1) {
          const name = pluginNames[0].toLowerCase();
          if (name === "all") {
            await uninstallAllPlugins(msg);
          } else {
            await uninstallPlugin(pluginNames[0], msg);
          }
        } else {
          await uninstallMultiplePlugins(pluginNames, msg);
        }
      } else if (cmd == "upload" || cmd == "ul") {
        await uploadPlugin(args, msg);
      } else if (cmd === "search" || cmd === "s") {
        await search(msg);
      } else if (cmd === "list" || cmd === "ls" || cmd === "lv") {
        await showPluginRecords(
          msg,
          ["-v", "--verbose"].includes(args[1]) || cmd === "lv"
        );
      } else if (cmd === "update" || cmd === "updateAll" || cmd === "ua") {
        await updateAllPlugins(msg);
      } else {
        await sendOrEditMessage(msg, `❌ 未知命令: <code>${cmd}</code>\n\n${this.description}`, { parseMode: "html" });
      }
    },
  };
}

export default new TpmPlugin();

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args?.[0] !== "install" || args?.length < 2) {
    console.log("Usage: node tpm.ts install <plugin1> <plugin2> ...");
  }
  installPlugin(args, {
    edit: async ({ text }: any) => {
      console.log(text);
    },
  } as any)
    .then(() => {
      console.log("Plugins processed successfully");
    })
    .catch((error) => {
      console.error("Error processing plugins:", error);
    });
}
