import { Plugin, isValidPlugin } from "@utils/pluginBase";
import { loadPlugins } from "@utils/pluginManager";
import { createDirectoryInTemp, createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import fs from "fs";
import axios from "axios";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const MAX_MESSAGE_LENGTH = 4000;

interface PluginRecord {
  url: string;
  desc?: string;
  _updatedAt: number;
}

type Database = Record<string, PluginRecord>;

const PLUGIN_PATH = path.join(process.cwd(), "plugins");

// Entity管理器：防止超过Telegram限制
class EntityManager {
  private count = 0;
  private readonly LIMIT = 95;
  private readonly IMPORTANT_TAGS = ['blockquote', 'a', 'b', 'i', 'u', 'pre'];
  
  canAdd(tag: string): boolean {
    return this.IMPORTANT_TAGS.includes(tag) || this.count < this.LIMIT;
  }
  
  add(tag: string) {
    this.count++;
  }
  
  hasReachedLimit(): boolean {
    return this.count >= this.LIMIT;
  }
}

// 发送或编辑消息
async function sendOrEditMessage(msg: Api.Message, text: string, options?: { parseMode?: string; linkPreview?: boolean }): Promise<Api.Message> {
  const messageOptions = { text, parseMode: "html" as any, linkPreview: false };
  try {
    await msg.edit(messageOptions);
    return msg;
  } catch (error) {
    console.log(`[TPM] 编辑消息失败，发送新消息: ${error}`);
  }
  return await msg.client?.sendMessage(msg.peerId, messageOptions) || msg;
}

// 长消息分割
function splitLongText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
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
  if (currentMessage) messages.push(currentMessage);
  return messages;
}

// 发送长消息
async function sendLongMessage(msg: Api.Message, text: string): Promise<void> {
  const messages = splitLongText(text);
  if (messages.length === 0) return;
  
  for (let i = 0; i < messages.length; i++) {
    if (i === 0) {
      await sendOrEditMessage(msg, messages[i]);
    } else {
      await msg.reply({ message: `📋 <b>续 ${i}/${messages.length - 1}：</b>\n\n${messages[i]}` });
    }
  }
}

// 获取数据库
async function getDatabase() {
  const filePath = path.join(createDirectoryInAssets("tpm"), "plugins.json");
  return await JSONFilePreset<Database>(filePath, {});
}

// 获取媒体文件名
async function getMediaFileName(msg: any): Promise<string> {
  const metadata = msg.media as any;
  return metadata.document.attributes[0].fileName;
}

// 安装远程插件
async function installRemotePlugin(plugin: string, msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, `正在安装插件 <code>${plugin}</code>...`);
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  
  try {
    const res = await axios.get(url);
    if (res.status !== 200 || !res.data[plugin]) {
      await sendOrEditMessage(statusMsg, `❌ 未找到插件 <code>${plugin}</code> 的远程资源`);
      return;
    }

    const pluginData = res.data[plugin];
    const response = await axios.get(pluginData.url);
    if (response.status !== 200) {
      await sendOrEditMessage(statusMsg, `❌ 无法下载插件 <code>${plugin}</code>`);
      return;
    }

    const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
    if (fs.existsSync(filePath)) {
      const cacheDir = createDirectoryInTemp("plugin_backups");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const backupPath = path.join(cacheDir, `${plugin}_${timestamp}.ts`);
      fs.copyFileSync(filePath, backupPath);
      console.log(`[TPM] 旧插件已备份: ${backupPath}`);
    }

    fs.writeFileSync(filePath, response.data);

    const db = await getDatabase();
    db.data[plugin] = { ...pluginData, _updatedAt: Date.now() };
    await db.write();
    console.log(`[TPM] 已记录插件: ${plugin}`);

    await loadPlugins();
    await sendOrEditMessage(statusMsg, `✅ 插件 <code>${plugin}</code> 已安装并加载成功`);
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 安装失败: <code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

// 安装所有插件
async function installAllPlugins(msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, "🔍 正在获取远程插件列表...");
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  
  try {
    const res = await axios.get(url);
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

    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      if (i % 2 === 0) {
        await sendOrEditMessage(statusMsg, `正在安装插件: <code>${plugin}</code> (${i + 1}/${totalPlugins})`);
      }

      try {
        const pluginData = res.data[plugin];
        if (!pluginData?.url) {
          failedCount++;
          failedPlugins.push(`${plugin}（无URL）`);
          continue;
        }

        const response = await axios.get(pluginData.url);
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${plugin}（下载失败）`);
          continue;
        }

        const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
        if (fs.existsSync(filePath)) {
          const cacheDir = createDirectoryInTemp("plugin_backups");
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
          const backupPath = path.join(cacheDir, `${plugin}_${timestamp}.ts`);
          fs.copyFileSync(filePath, backupPath);
        }

        fs.writeFileSync(filePath, response.data);
        installedCount++;
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${plugin}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }

    await loadPlugins();
    let resultMsg = `🎉 <b>批量安装完成！</b>\n\n📊 <b>统计：</b>\n✅ 成功：${installedCount}/${totalPlugins}\n❌ 失败：${failedCount}/${totalPlugins}`;
    
    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).join("\n• ");
      const moreFailures = failedPlugins.length > 5 ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败` : "";
      resultMsg += `\n\n❌ <b>失败详情：</b>\n• ${failedList}${moreFailures}`;
    }
    
    resultMsg += `\n\n🔄 插件已重新加载`;
    await sendOrEditMessage(statusMsg, resultMsg);
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 批量安装失败：<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

// 卸载插件
async function uninstallPlugin(plugin: string, msg: Api.Message) {
  if (!plugin) {
    await sendOrEditMessage(msg, "❌ 请提供要卸载的插件名称");
    return;
  }
  
  const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
  if (!fs.existsSync(filePath)) {
    await sendOrEditMessage(msg, `❌ 未找到插件 <code>${plugin}</code>`);
    return;
  }

  try {
    fs.unlinkSync(filePath);
    const db = await getDatabase();
    if (db.data[plugin]) {
      delete db.data[plugin];
      await db.write();
    }
    await loadPlugins();
    await sendOrEditMessage(msg, `✅ 插件 <code>${plugin}</code> 已卸载`);
  } catch (error) {
    await sendOrEditMessage(msg, `❌ 卸载失败：<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

// 显示插件记录
async function showPluginRecords(msg: Api.Message, verbose: boolean = false) {
  try {
    const statusMsg = await sendOrEditMessage(msg, "📚 正在读取插件数据...");
    const db = await getDatabase();
    const dbNames = Object.keys(db.data);

    let filePlugins: string[] = [];
    try {
      if (fs.existsSync(PLUGIN_PATH)) {
        filePlugins = fs.readdirSync(PLUGIN_PATH)
          .filter((f) => f.endsWith(".ts") && !f.includes("backup") && !f.endsWith(".d.ts") && !f.startsWith("_"))
          .map((f) => f.replace(/\.ts$/, ""));
      }
    } catch (err) {
      console.error("[TPM] 读取本地插件失败:", err);
    }

    const notInDb = filePlugins.filter((n) => !dbNames.includes(n));
    const sortedPlugins = dbNames
      .map((name) => ({ name, ...db.data[name] }))
      .sort((a, b) => a._updatedAt - b._updatedAt);

    const entityMgr = new EntityManager();
    const dbLines: string[] = [];
    
    for (const p of sortedPlugins) {
      const allowCodeTag = entityMgr.canAdd('code');
      const nameTag = allowCodeTag ? `<code>${p.name}</code>` : p.name;
      
      if (verbose) {
        const updateTime = new Date(p._updatedAt).toLocaleString("zh-CN");
        const desc = p.desc ? `<i>${htmlEscape(p.desc)}</i>\n` : "";
        const urlTag = allowCodeTag ? `<code>${p.url}</code>` : p.url;
        dbLines.push(`${nameTag} - 🕒 ${updateTime}\n${desc}🔗 ${urlTag}`);
      } else {
        dbLines.push(`${nameTag}${p.desc ? ` - <i>${htmlEscape(p.desc)}</i>` : ""}`);
      }
      
      if (allowCodeTag) entityMgr.add('code');
    }

    const localLines = notInDb.map(name => {
      const allowCodeTag = entityMgr.canAdd('code');
      return allowCodeTag ? `<code>${name}</code>` : name;
    });

    const messageParts = [
      `📚 <b>插件记录</b>`,
      `━━━━━━━━━━━━━━━━━`,
      ``,
      `📦 <b>远程插件记录（${dbNames.length}个）：</b>`
    ];

    if (dbLines.length > 0) {
      messageParts.push(`<blockquote expandable>${dbLines.join("\n")}</blockquote>`);
    } else {
      messageParts.push(`<i>暂无记录</i>`);
    }

    if (notInDb.length > 0) {
      messageParts.push(``, `🗂 <b>本地插件（${notInDb.length}个）：</b>`, `<blockquote expandable>${localLines.join("\n")}</blockquote>`);
    }

    messageParts.push(``, `━━━━━━━━━━━━━━━━━`, `📊 总计：${dbNames.length + notInDb.length} 个插件`);
    
    if (!verbose) {
      messageParts.push(``, `💡 使用 <code>${mainPrefix}tpm lv</code> 查看详细信息`);
    }

    await sendLongMessage(statusMsg, messageParts.join("\n"));
  } catch (error) {
    await sendOrEditMessage(msg, `❌ 读取数据库失败：<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

// 更新所有插件
async function updateAllPlugins(msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, "🔍 正在检查待更新的插件...");
  
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

    for (let i = 0; i < dbPlugins.length; i++) {
      const pluginName = dbPlugins[i];
      const pluginRecord = db.data[pluginName];
      
      if (!pluginRecord?.url) {
        skipCount++;
        continue;
      }

      try {
        const response = await axios.get(pluginRecord.url);
        if (response.status !== 200) throw new Error("下载失败");

        const filePath = path.join(PLUGIN_PATH, `${pluginName}.ts`);
        if (!fs.existsSync(filePath)) {
          skipCount++;
          continue;
        }

        const currentContent = fs.readFileSync(filePath, "utf8");
        if (currentContent === response.data) {
          skipCount++;
          continue;
        }

        // 备份旧版本
        const cacheDir = createDirectoryInTemp("plugin_backups");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
        const backupPath = path.join(cacheDir, `${pluginName}_${timestamp}.ts`);
        fs.copyFileSync(filePath, backupPath);

        // 写入新版本
        fs.writeFileSync(filePath, response.data);
        
        // 更新数据库记录
        db.data[pluginName]._updatedAt = Date.now();
        
        updatedCount++;
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${pluginName}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }

    await db.write();
    await loadPlugins();

    let resultMsg = `🎉 <b>更新完成！</b>\n\n📊 <b>统计：</b>\n✅ 成功：${updatedCount}\n⏭️ 跳过：${skipCount}\n❌ 失败：${failedCount}`;
    
    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).join("\n• ");
      const moreFailures = failedPlugins.length > 5 ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败` : "";
      resultMsg += `\n\n❌ <b>失败详情：</b>\n• ${failedList}${moreFailures}`;
    }
    
    await sendOrEditMessage(statusMsg, resultMsg);
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 一键更新失败：<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

class TpmPlugin extends Plugin {
  name = "tpm";
  description = `📦 TeleBox 插件管理器 (TPM)

<b>📝 功能描述：</b>
• 安装、卸载、更新远程插件
• 管理本地插件文件
• 插件版本控制和备份
• 批量操作支持

<b>🔧 查看插件：</b>
• <code>${mainPrefix}tpm search</code> - 显示远程插件列表
• <code>${mainPrefix}tpm ls</code> - 查看已安装记录
• <code>${mainPrefix}tpm lv</code> - 查看详细记录

<b>🔧 安装插件：</b>
• <code>${mainPrefix}tpm i &lt;插件名&gt;</code> - 安装单个插件
• <code>${mainPrefix}tpm i &lt;插件1&gt; &lt;插件2&gt;</code> - 批量安装
• <code>${mainPrefix}tpm i all</code> - 安装全部远程插件
• <code>${mainPrefix}tpm i</code>（回复插件文件）- 安装本地插件

<b>🔧 更新插件：</b>
• <code>${mainPrefix}tpm update</code> - 一键更新所有已安装插件

<b>🔧 卸载插件：</b>
• <code>${mainPrefix}tpm rm &lt;插件名&gt;</code> - 卸载插件
• <code>${mainPrefix}tpm rm all</code> - 清空所有插件

<b>💡 插件仓库：</b> <a href="https://github.com/TeleBoxDev/TeleBox_Plugins">TeleBox_Plugins</a>`;

  ignoreEdited: boolean = true;
  private activeRequests: any[] = [];

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    tpm: async (msg) => {
      const text = msg.text || "";
      const [, ...args] = text.split(" ");
      const cmd = args[0]?.toLowerCase();

      if (!cmd) {
        await sendOrEditMessage(msg, this.description);
        return;
      }

      switch (cmd) {
        case "install":
        case "i":
          if (args.length === 1 && msg.isReply) {
            await this.installLocalPlugin(msg);
          } else if (args[1] === "all") {
            await installAllPlugins(msg);
          } else if (args.length > 1) {
            for (let i = 1; i < args.length; i++) {
              await installRemotePlugin(args[i], msg);
            }
          } else {
            await sendOrEditMessage(msg, "❌ 请提供插件名称或回复插件文件");
          }
          break;
        case "uninstall":
        case "rm":
          if (args[1] === "all") {
            await this.uninstallAllPlugins(msg);
          } else if (args.length > 1) {
            for (let i = 1; i < args.length; i++) {
              await uninstallPlugin(args[i], msg);
            }
          } else {
            await sendOrEditMessage(msg, "❌ 请提供要卸载的插件名称");
          }
          break;
        case "search":
        case "s":
          await this.searchRemotePlugins(msg);
          break;
        case "list":
        case "ls":
        case "lv":
          await showPluginRecords(msg, cmd === "lv" || args[1] === "-v");
          break;
        case "update":
          await updateAllPlugins(msg);
          break;
        default:
          await sendOrEditMessage(msg, this.description);
      }
    }
  };

  private async installLocalPlugin(msg: Api.Message): Promise<void> {
    const replied = await msg.getReplyMessage();
    if (!replied?.media) {
      await sendOrEditMessage(msg, "❌ 请回复一个插件文件");
      return;
    }

    const fileName = await getMediaFileName(replied);
    if (!fileName.endsWith(".ts")) {
      await sendOrEditMessage(msg, `❌ 文件格式错误：<code>${fileName}</code> 不是有效的插件文件`);
      return;
    }

    const pluginName = fileName.replace(".ts", "");
    const statusMsg = await sendOrEditMessage(msg, `🔍 正在验证插件 <code>${pluginName}</code>...`);
    
    try {
      const filePath = path.join(PLUGIN_PATH, fileName);
      await msg.client?.downloadMedia(replied, { outputFile: filePath });

      const pluginModule = require(filePath);
      const pluginInstance = pluginModule.default || pluginModule;
      
      if (!isValidPlugin(pluginInstance)) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await sendOrEditMessage(statusMsg, "❌ 插件验证失败：不是有效的插件格式");
        return;
      }

      await sendOrEditMessage(statusMsg, `✅ 验证通过，正在安装 <code>${pluginName}</code>...`);
      
      // 如果是通过TPM安装的，清除数据库记录
      const db = await getDatabase();
      if (db.data[pluginName]) {
        delete db.data[pluginName];
        await db.write();
      }

      await loadPlugins();
      await sendOrEditMessage(statusMsg, `✅ 插件 <code>${pluginName}</code> 已安装并加载成功`);
    } catch (error) {
      await sendOrEditMessage(statusMsg, `❌ 安装失败：<code>${error instanceof Error ? error.message : String(error)}</code>`);
    }
  }

  private async uninstallAllPlugins(msg: Api.Message): Promise<void> {
    const statusMsg = await sendOrEditMessage(msg, "⚠️ <b>正在清空插件目录...</b>");
    
    let removed = 0;
    let failed: string[] = [];

    try {
      if (fs.existsSync(PLUGIN_PATH)) {
        const files = fs.readdirSync(PLUGIN_PATH);
        for (const file of files) {
          const full = path.join(PLUGIN_PATH, file);
          const isPluginTs = file.endsWith(".ts") && !file.includes("backup") && !file.endsWith(".d.ts") && !file.startsWith("_");
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

    let text = `✅ <b>已清空插件目录并刷新缓存</b>\n\n🗑️ 删除文件：${removed} 个`;
    if (failed.length) {
      text += `\n❌ 删除失败：${failed.length} 个\n• ${failed.slice(0, 5).join("\n• ")}${failed.length > 5 ? `\n• ... 还有 ${failed.length - 5} 个` : ""}`;
    }
    
    await sendOrEditMessage(statusMsg, text);
  }

  private async searchRemotePlugins(msg: Api.Message): Promise<void> {
    const text = msg.text || "";
    const parts = text.trim().split(/\s+/);
    const keyword = parts.length > 2 ? parts[2].toLowerCase() : "";
    const statusMsg = await sendOrEditMessage(msg, keyword ? `🔍 正在搜索: <code>${keyword}</code>` : "🔍 正在获取插件列表...");

    try {
      const res = await axios.get(
        `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`,
        { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } }
      );
      
      if (res.status !== 200) {
        await sendOrEditMessage(statusMsg, "❌ 无法获取远程插件库");
        return;
      }

      const remotePlugins = res.data;
      const pluginNames = Object.keys(remotePlugins);
      const localPlugins = new Set<string>();
      
      try {
        if (fs.existsSync(PLUGIN_PATH)) {
          fs.readdirSync(PLUGIN_PATH)
            .filter((f) => f.endsWith(".ts") && !f.includes("backup"))
            .forEach((f) => localPlugins.add(f.replace(".ts", "")));
        }
      } catch (error) {
        console.error("[TPM] 读取本地插件失败:", error);
      }

      const db = await getDatabase();
      const filteredPlugins = keyword
        ? pluginNames.filter(name => {
            const pluginData = remotePlugins[name];
            return name.toLowerCase().includes(keyword) || pluginData?.desc?.toLowerCase().includes(keyword);
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
      const pluginLines: string[] = [];

      for (const plugin of filteredPlugins) {
        const pluginData = remotePlugins[plugin];
        const remoteUrl = pluginData?.url || "";
        const hasLocal = localPlugins.has(plugin);
        const dbRecord = db.data[plugin];
        
        let status: string;
        if (hasLocal && dbRecord && dbRecord.url === remoteUrl) {
          status = "✅"; installedCount++;
        } else if (hasLocal && !dbRecord) {
          status = "🔶"; localOnlyCount++;
        } else {
          status = "❌"; notInstalledCount++;
        }

        const allowCodeTag = entityMgr.canAdd('code');
        const nameTag = allowCodeTag ? `<code>${plugin}</code>` : plugin;
        const desc = pluginData?.desc ? htmlEscape(pluginData.desc) : "暂无描述";
        
        pluginLines.push(`${status} ${nameTag} - <i>${desc}</i>`);
        
        if (allowCodeTag) entityMgr.add('code');
      }

      const statsInfo = [
        `📊 <b>插件统计：</b>`,
        `• 总计：${totalPlugins} 个插件`,
        `• ✅ 已安装：${installedCount} 个`,
        `• 🔶 本地插件：${localOnlyCount} 个`,
        `• ❌ 未安装：${notInstalledCount} 个`,
        ...(keyword ? [`• 搜索关键词："<b>${keyword}</b>"`] : [])
      ];

      const installTip = [
        `\n💡 <b>快捷操作：</b>`,
        `• <code>${mainPrefix}tpm i &lt;名称&gt;</code> - 安装插件`,
        `• <code>${mainPrefix}tpm i all</code> - 安装全部`,
        `• <code>${mainPrefix}tpm update</code> - 更新插件`,
        `• <code>${mainPrefix}tpm rm &lt;名称&gt;</code> - 卸载插件`
      ];

      const message = [
        `🔍 <b>${keyword ? `搜索 "${keyword}" 结果` : '远程插件列表'}</b>`,
        `━━━━━━━━━━━━━━━━━`,
        ``,
        ...statsInfo,
        ``,
        `📦 <b>插件列表：</b>`,
        `<blockquote expandable>${pluginLines.join("\n")}</blockquote>`,
        ...installTip,
        ``,
        `🔗 <b>插件仓库：</b> <a href="https://github.com/TeleBoxDev/TeleBox_Plugins">TeleBox_Plugins</a>`
      ];

      await sendLongMessage(statusMsg, message.join("\n"));
    } catch (error) {
      console.error("[TPM] 搜索插件失败:", error);
      await sendOrEditMessage(statusMsg, `❌ 搜索失败：<code>${error instanceof Error ? error.message : String(error)}</code>`);
    }
  }
  
  async cleanup(): Promise<void> {
    try {
      // 清理所有活动请求
      for (const request of this.activeRequests) {
        try {
          if (request.cancel) request.cancel();
        } catch (e) {}
      }
      this.activeRequests = [];
      console.log("[TPMPlugin] Cleanup completed");
    } catch (error) {
      console.error("[TPMPlugin] Error during cleanup:", error);
    }
  }
}

export default new TpmPlugin();