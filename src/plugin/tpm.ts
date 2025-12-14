import { Plugin } from "@utils/pluginBase";
import { loadPlugins } from "@utils/pluginManager";
import {
  createDirectoryInTemp,
  createDirectoryInAssets,
} from "@utils/pathHelpers";
import path from "path";
import fs from "fs";
import axios from "axios";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 数据库类型定义 (精简: 直接用 根对象 { [name]: PluginRecord })
interface PluginRecord {
  url: string;
  desc?: string; // 插件描述
  _updatedAt: number; // 时间戳
}

type Database = Record<string, PluginRecord>;

const PLUGIN_PATH = path.join(process.cwd(), "plugins");

// 辅助函数：智能发送或编辑消息，支持群组话题和回复
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

  // 优先尝试编辑消息（私聊、自己发送的消息、或bot消息）
  try {
    await msg.edit(messageOptions);
    return msg;
  } catch (error) {
    console.log(`[TPM] 编辑消息失败，尝试发送新消息: ${error}`);
  }

  // 编辑失败时，在群组中发送新消息，保持话题上下文
  const sendOptions: any = {
    message: text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  // 如果原消息是回复消息，保持回复关系
  if (msg.replyTo?.replyToMsgId) {
    sendOptions.replyTo = msg.replyTo.replyToMsgId;
  }

  const newMsg = await msg.client?.sendMessage(msg.peerId, sendOptions);
  return newMsg || msg;
}

// 专用于更新进度的函数：只编辑，失败则静默
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

// 初始化数据库 (并迁移旧结构 { plugins: {...} } 到扁平结构)
async function getDatabase() {
  const filePath = path.join(createDirectoryInAssets("tpm"), "plugins.json");
  const db = await JSONFilePreset<Database>(filePath, {});
  return db;
}

async function getMediaFileName(msg: any): Promise<string> {
  const metadata = msg.media as any;
  return metadata.document.attributes[0].fileName;
}

async function installRemotePlugin(plugin: string, msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, `正在安装插件 ${plugin}...`);
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  const res = await axios.get(url);
  if (res.status === 200) {
    if (!res.data[plugin]) {
      await sendOrEditMessage(statusMsg, `未找到插件 ${plugin} 的远程资源`);
      return;
    }
    const pluginUrl = res.data[plugin].url;
    const response = await axios.get(pluginUrl);
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

        const pluginUrl = pluginData.url;
        const response = await axios.get(pluginUrl);
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
    const statusMsg = await sendOrEditMessage(msg, "❌ 未提供要安装的插件名称");
    return;
  }

  const statusMsg = await sendOrEditMessage(msg, `🔍 正在获取远程插件列表...`, { parseMode: "html" });

  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  try {
    const res = await axios.get(url);
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
        // 更新进度显示
        if ([0, pluginNames.length - 1].includes(i) || i % 2 === 0) {
          await sendOrEditMessage(statusMsg, `📦 正在安装插件: <code>${pluginName}</code>\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${installedCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        // 检查插件是否存在于远程库
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

        const pluginUrl = pluginData.url;
        const response = await axios.get(pluginUrl);
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${pluginName} (下载失败)`);
          continue;
        }

        const filePath = path.join(PLUGIN_PATH, `${pluginName}.ts`);
        const oldBackupPath = path.join(PLUGIN_PATH, `${pluginName}.ts.backup`);

        // 备份现有插件
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

        // 清理旧备份文件
        if (fs.existsSync(oldBackupPath)) {
          fs.unlinkSync(oldBackupPath);
          console.log(`[TPM] 已清理旧备份文件: ${oldBackupPath}`);
        }

        // 写入新插件文件
        fs.writeFileSync(filePath, response.data);

        // 更新数据库记录
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

    // 重新加载插件
    try {
      await loadPlugins();
    } catch (error) {
      console.error("[TPM] 重新加载插件失败:", error);
    }

    // 生成结果消息
    const successBar = generateProgressBar(100);
    let resultMsg = `🎉 <b>批量安装完成!</b>\n\n${successBar}\n\n📊 <b>安装统计:</b>\n✅ 成功安装: ${installedCount}/${totalPlugins}\n❌ 安装失败: ${failedCount}/${totalPlugins}`;

    // 添加未找到的插件列表
    if (notFoundPlugins.length > 0) {
      const notFoundList = notFoundPlugins.slice(0, 5).join("\n• ");
      const moreNotFound =
        notFoundPlugins.length > 5
          ? `\n• ... 还有 ${notFoundPlugins.length - 5} 个未找到`
          : "";
      resultMsg += `\n\n🔍 <b>未找到的插件:</b>\n• ${notFoundList}${moreNotFound}`;
    }

    // 添加其他失败的插件列表
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
  return `🔄 <b>进度条:</b> [${bar}] ${percentage}%`;
}

async function installPlugin(args: string[], msg: Api.Message) {
  if (args.length === 1) {
    if (msg.isReply) {
      const replied = await msg.getReplyMessage();
      if (replied?.media) {
        const fileName = await getMediaFileName(replied);
        const pluginName = fileName.replace(".ts", "");
        const statusMsg = await sendOrEditMessage(msg, `正在安装插件 ${pluginName} ...`);
        const filePath = path.join(PLUGIN_PATH, fileName);

        // 检查数据库中是否已存在同名插件
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

        await msg.client?.downloadMedia(replied, { outputFile: filePath });
        await loadPlugins();
        await sendOrEditMessage(statusMsg, `插件 ${pluginName} 已安装并加载成功${overrideMessage}`, { parseMode: "html" });
      } else {
        await sendOrEditMessage(msg, "请回复一个插件文件");
      }
    } else {
      await sendOrEditMessage(msg, "请回复某个插件文件或提供 tpm 包名");
    }
  } else {
    // 获取所有插件名称参数（从args[1]开始）
    const pluginNames = args.slice(1);

    // 检查是否包含特殊命令
    if (pluginNames.length === 1 && pluginNames[0] === "all") {
      await installAllPlugins(msg);
    } else if (pluginNames.length === 1) {
      // 单个插件安装
      await installRemotePlugin(pluginNames[0], msg);
    } else {
      // 多个插件安装
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

  // 初始消息
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
          // 删除文件
          fs.unlinkSync(pluginPath);

          // 从数据库中删除记录
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

      // 更新进度
      await sendOrEditMessage(statusMsg, `卸载插件中...\n${generateProgressBar(
          percentage
        )} ${processedCount}/${totalCount}\n当前: ${trimmedName}`);
    }

    // 保存数据库更改
    await db.write();
  } catch (error) {
    console.error(`[TPM] 批量卸载过程中发生错误:`, error);
    await sendOrEditMessage(msg, `批量卸载过程中发生错误: ${
        error instanceof Error ? error.message : String(error)
      }`);
    return;
  }

  // 重新加载插件
  await loadPlugins();

  // 生成结果报告
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

// 清空插件目录并刷新本地缓存
async function uninstallAllPlugins(msg: Api.Message) {
  try {
    const statusMsg = await sendOrEditMessage(msg, "⚠️ 正在清空插件目录并刷新缓存...");

    let removed = 0;
    let failed: string[] = [];

    // 删除 plugins 目录下的 .ts 插件文件（排除备份、声明文件和下划线前缀）
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

    // 清空数据库
    try {
      const db = await getDatabase();
      for (const k of Object.keys(db.data)) delete db.data[k];
      await db.write();
    } catch (e) {
      console.error("[TPM] 清空数据库失败:", e);
    }

    // 重新加载插件
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
  
  // 构建发送选项
  const sendOptions: any = {
    file: pluginPath,
    thumb: path.join(process.cwd(), "telebox.png"),
    caption: `**TeleBox_Plugin ${pluginName} plugin.**`,
  };

  // 如果原消息是回复消息，则上传的文件也作为回复发送
  if (msg.replyTo?.replyToMsgId) {
    sendOptions.replyTo = msg.replyTo.replyToMsgId;
  }

  await msg.client?.sendFile(msg.peerId, sendOptions);
  
  // 删除状态消息
  if (statusMsg.id !== msg.id) {
    await statusMsg.delete();
  } else {
    await msg.delete();
  }
}

async function search(msg: Api.Message) {
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  try {
    const statusMsg = await sendOrEditMessage(msg, "🔍 正在获取插件列表...");
    const res = await axios.get(url);
    if (res.status !== 200) {
      await sendOrEditMessage(statusMsg, `❌ 无法获取远程插件库`);
      return;
    }
    const remotePlugins = res.data;
    const pluginNames = Object.keys(remotePlugins);

    // 获取本地插件文件列表
    const localPlugins = new Set<string>();
    try {
      const files = fs.readdirSync(PLUGIN_PATH);
      files.forEach((file) => {
        if (file.endsWith(".ts") && !file.includes("backup")) {
          localPlugins.add(file.replace(".ts", ""));
        }
      });
    } catch (error) {
      console.error("[TPM] 读取本地插件失败:", error);
    }

    // 获取数据库记录
    const db = await getDatabase();
    const dbPlugins = db.data;

    const totalPlugins = pluginNames.length;
    let installedCount = 0;
    let localOnlyCount = 0;
    let notInstalledCount = 0;

    // 判断插件状态的函数（统计 + 返回标签）
    function getPluginStatus(pluginName: string, remoteUrl: string) {
      const hasLocal = localPlugins.has(pluginName);
      const dbRecord = dbPlugins[pluginName];

      if (hasLocal && dbRecord && dbRecord.url === remoteUrl) {
        // 已安装: 本地有文件 + 数据库有记录 + URL匹配
        installedCount++;
        return { status: "✅", label: "已安装" } as const;
      } else if (hasLocal && !dbRecord) {
        // 本地同名插件: 本地有文件但数据库无记录
        localOnlyCount++;
        return { status: "🔶", label: "本地同名" } as const;
      } else {
        // 未安装: 本地无文件或URL不匹配
        notInstalledCount++;
        return { status: "❌", label: "未安装" } as const;
      }
    }

    // 生成完整的插件行（保持远程列表原始顺序，不分组）并缓存状态，避免重复统计
    const pluginEntries: { name: string; status: string; desc: string }[] = [];
    for (const plugin of pluginNames) {
      const pluginData = remotePlugins[plugin];
      const remoteUrl = pluginData?.url || "";
      const { status } = getPluginStatus(plugin, remoteUrl);
      const description = pluginData?.desc || "暂无描述";
      pluginEntries.push({ name: plugin, status, desc: description });
    }
    
    // 关键修改：只对前85个插件使用<code>标签，后面的不用
    const pluginLines: string[] = pluginEntries.map((p, index) => {
      if (index < 85) {
        return `${p.status} <code>${p.name}</code> - ${p.desc}`;
      } else {
        return `${p.status} ${p.name} - ${p.desc}`;
      }
    });

    const statsInfo =
      `📊 <b>插件统计:</b>\n` +
      `• 总计: ${totalPlugins} 个插件\n` +
      `• ✅ 已安装: ${installedCount} 个\n` +
      `• 🔶 本地同名: ${localOnlyCount} 个\n` +
      `• ❌ 未安装: ${notInstalledCount} 个`;

    const installTip =
      `\n💡 <b>快捷操作</b>\n` +
      `• <code>${mainPrefix}tpm i &lt;名称 [名称2 ...]&gt;</code> 安装/批量安装\n` +
      `• <code>${mainPrefix}tpm i all</code> 全部安装\n` +
      `• <code>${mainPrefix}tpm update</code> 更新已装\n` +
      `• <code>${mainPrefix}tpm ls</code> 查看记录\n` +
      `• <code>${mainPrefix}tpm rm &lt;名称&gt;</code> 卸载 \n` +
      `• <code>${mainPrefix}tpm rm all</code> 清空`;

    const repoLink = `\n🔗 <b>插件仓库:</b> <a href="https://github.com/TeleBoxDev/TeleBox_Plugins">TeleBox_Plugins</a>`;

    // 构造单条消息，插件列表整体折叠
    const MAX_LEN = 3500; // 保守阈值，避免超过Telegram限制
    // 修复：移除blockquote标签内的首尾换行符，避免第一行空行
    const makeMessage = (lines: string[]) =>
      `🔍 <b>远程插件列表:</b>\n\n${statsInfo}\n\n<b>插件详情（点击展开）:</b>\n<blockquote expandable>${lines.join("\n")}</blockquote>\n${installTip}\n${repoLink}`;
    const makeMessageMinimal = (lines: string[]) =>
      `🔍 <b>远程插件列表:</b>\n\n${statsInfo}\n\n<blockquote expandable>${lines.join("\n")}</blockquote>`;

    let message = makeMessage(pluginLines);

    // 如果消息过长，尝试去掉描述，仅保留插件名以保证单条消息
    if (message.length > MAX_LEN) {
      const compactLines = pluginEntries.map((p, index) => {
        if (index < 85) {
          return `${p.status} <code>${p.name}</code>`;
        } else {
          return `${p.status} ${p.name}`;
        }
      });
      message = makeMessage(compactLines);

      // 仍然过长，则去掉安装提示与仓库链接
      if (message.length > MAX_LEN) {
        message = makeMessageMinimal(compactLines);
      }

      // 仍超长，裁剪行数以适配，并在末尾追加省略提示
      if (message.length > MAX_LEN) {
        const trimmed: string[] = [];
        let acc = 0;
        for (const line of compactLines) {
          const l = line.length + 1; // 包含换行
          if (acc + l > MAX_LEN - 200) break; // 为标题等预留空间
          trimmed.push(line);
          acc += l;
        }
        const omitted = compactLines.length - trimmed.length;
        if (omitted > 0) trimmed.push(`... 还有 ${omitted} 个`);
        message = makeMessageMinimal(trimmed);
      }
    }

    await sendOrEditMessage(statusMsg, message, { parseMode: "html", linkPreview: false });
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

    // 读取本地插件目录
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

    // 构建数据库记录列表（按更新时间降序）
    const sortedPlugins = dbNames
      .map((name) => ({ name, ...db.data[name] }))
      .sort((a, b) => b._updatedAt - a._updatedAt);

    // 关键修改：只对前85个远程插件使用<code>标签
    const dbLinesSimple = sortedPlugins.map((p, index) => {
      if (index < 85) {
        return `<code>${p.name}</code>${p.desc ? ` - ${p.desc}` : ""}`;
      } else {
        return `${p.name}${p.desc ? ` - ${p.desc}` : ""}`;
      }
    });
    
    const dbLinesVerbose = sortedPlugins.map((p, index) => {
      const updateTime = new Date(p._updatedAt).toLocaleString("zh-CN");
      const desc = p.desc ? `\n📝 ${p.desc}` : "";
      if (index < 85) {
        return `<code>${p.name}</code> 🕒 ${updateTime}${desc}\n🔗 <a href="${p.url}">URL</a>`;
      } else {
        return `${p.name} 🕒 ${updateTime}${desc}\n🔗 <a href="${p.url}">URL</a>`;
      }
    });

    // 关键修改：只对前85个本地插件使用<code>标签
    const localLinesSimple = notInDb.map((name, index) => {
      if (index < 85) {
        return `<code>${name}</code>`;
      } else {
        return name;
      }
    });
    
    const localLinesVerbose = notInDb.map((name, index) => {
      const filePath = path.join(PLUGIN_PATH, `${name}.ts`);
      let mtime = "未知";
      try {
        const stat = fs.statSync(filePath);
        mtime = stat.mtime.toLocaleString("zh-CN");
      } catch {}
      if (index < 85) {
        return `<code>${name}</code> 🗄 ${mtime}`;
      } else {
        return `${name} 🗄 ${mtime}`;
      }
    });

    const MAX_LEN = 3500;
    const tip = verbose
      ? ""
      : `💡 可使用 <code>${mainPrefix}tpm ls -v</code> 查看详情信息`;

    // 修复：移除blockquote标签内的首尾换行符，避免第一行空行
    const makeMessage = (
      dbLines: string[],
      localLines: string[]
    ): string => {
      const dbBlock = dbLines.length
        ? `\n<blockquote expandable>${dbLines.join("\n")}</blockquote>`
        : `\n<blockquote expandable>（空）</blockquote>`;
      const localPart = notInDb.length
        ? `\n🗂 <b>本地插件 (${notInDb.length}个):</b>\n<blockquote expandable>${localLines.join(
            "\n"
          )}</blockquote>`
        : "";
      return `${tip ? tip + "\n\n" : ""}📚 <b>远程插件记录 (${dbNames.length}个)</b>${dbBlock}${localPart}`;
    };

    // 首选：按 verbose 参数使用对应行
    let useVerbose = !!verbose;
    let dbUse = useVerbose ? dbLinesVerbose : dbLinesSimple;
    let localUse = useVerbose ? localLinesVerbose : localLinesSimple;
    let message = makeMessage(dbUse, localUse);

    // Fallback 1：过长则退化到简洁模式
    if (message.length > MAX_LEN && useVerbose) {
      useVerbose = false;
      dbUse = dbLinesSimple;
      localUse = localLinesSimple;
      message = makeMessage(dbUse, localUse);
    }

    // Fallback 2：仍过长则裁剪行数，附省略说明
    if (message.length > MAX_LEN) {
      let dbTrim = [...dbUse];
      let localTrim = [...localUse];
      let dbOmit = 0;
      let localOmit = 0;

      const buildWithOmit = () => {
        const dbLines = [...dbTrim];
        const localLines = [...localTrim];
        if (dbOmit > 0) dbLines.push(`... 还有 ${dbOmit} 个`);
        if (localOmit > 0) localLines.push(`... 还有 ${localOmit} 个`);
        return makeMessage(dbLines, localLines);
      };

      message = buildWithOmit();
      while (message.length > MAX_LEN && (dbTrim.length > 0 || localTrim.length > 0)) {
        if (dbTrim.length >= localTrim.length && dbTrim.length > 0) {
          dbTrim.pop();
          dbOmit++;
        } else if (localTrim.length > 0) {
          localTrim.pop();
          localOmit++;
        } else {
          break;
        }
        message = buildWithOmit();
      }
    }

    await sendOrEditMessage(statusMsg, message, { parseMode: "html", linkPreview: false });
  } catch (error) {
    console.error("[TPM] 读取插件数据库失败:", error);
    await sendOrEditMessage(msg, `❌ 读取数据库失败: ${error}`);
  }
}

async function updateAllPlugins(msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, "🔍 正在检查待更新的插件...");
  let canEdit = true; // 跟踪是否还能编辑消息
  
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
        // 只在能编辑且需要更新进度时才尝试编辑
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

        // 下载最新版本
        const response = await axios.get(pluginRecord.url);
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${pluginName} (下载失败)`);
          continue;
        }

        const filePath = path.join(PLUGIN_PATH, `${pluginName}.ts`);

        // 检查文件是否存在
        if (!fs.existsSync(filePath)) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 本地文件不存在`);
          continue;
        }

        // 检查内容是否有变化
        const currentContent = fs.readFileSync(filePath, "utf8");
        if (currentContent === response.data) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 内容无变化`);
          continue;
        }

        // 备份旧版本
        const cacheDir = createDirectoryInTemp("plugin_backups");
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, -5);
        const backupPath = path.join(cacheDir, `${pluginName}_${timestamp}.ts`);
        fs.copyFileSync(filePath, backupPath);
        console.log(`[TPM] 旧版本已备份到: ${backupPath}`);

        // 写入新版本
        fs.writeFileSync(filePath, response.data);

        // 更新数据库记录
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

    // 重新加载插件
    try {
      await loadPlugins();
    } catch (error) {
      console.error("[TPM] 重新加载插件失败:", error);
    }

    // 更新完成后删除状态消息
    try {
      await statusMsg.delete();
      console.log(`[TPM] 更新完成，已删除状态消息。统计: 成功${updatedCount}个, 跳过${skipCount}个, 失败${failedCount}个`);
    } catch (error) {
      console.log(`[TPM] 删除状态消息失败: ${error}`);
      // 如果删除失败，尝试最后一次编辑显示完成状态
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
    // 发生错误时尝试删除消息，如果删除失败则显示错误
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
  console.log("TeleBox Plugin Manager (TPM) - Command Line Mode");
  // console.log("Command line arguments:", process.argv.slice(2));

  const args = process.argv.slice(2);
  if (args.length === 0 || args?.[0] !== "install" || args?.length < 2) {
    console.log("Usage: node tpm.ts <command> [options]");
    console.log("Available commands:");
    console.log("  install <plugin1> <plugin2> ...   - Install plugins");
  }
  installPlugin(args, {
    edit: async ({ text }: any) => {
      console.log(text);
    },
  } as any)
    .then(() => {
      console.log("Plugins installed successfully");
    })
    .catch((error) => {
      console.error("Error installing plugins:", error);
    });
}
