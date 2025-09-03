import { Plugin } from "@utils/pluginBase";
import { loadPlugins } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import path from "path";
import fs from "fs";
import axios from "axios";
import { Api } from "telegram";

const PLUGIN_PATH = path.join(process.cwd(), "plugins");

async function getMediaFileName(msg: any): Promise<string> {
  const metadata = msg.media as any;
  return metadata.document.attributes[0].fileName;
}

async function installRemotePlugin(plugin: string, msg: Api.Message) {
  await msg.edit({ text: `正在安装插件 ${plugin}...` });
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  const res = await axios.get(url);
  if (res.status === 200) {
    if (!res.data[plugin]) {
      await msg.edit({ text: `未找到插件 ${plugin} 的远程资源` });
      return;
    }
    const pluginUrl = res.data[plugin].url;
    const response = await axios.get(pluginUrl);
    if (response.status !== 200) {
      await msg.edit({ text: `无法下载插件 ${plugin}` });
      return;
    }
    // 检查插件是否已存在
    const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
    const oldBackupPath = path.join(PLUGIN_PATH, `${plugin}.ts.backup`);
    
    if (fs.existsSync(filePath)) {
      // 将现有插件转移到缓存目录
      const cacheDir = createDirectoryInTemp('plugin_backups');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const backupPath = path.join(cacheDir, `${plugin}_${timestamp}.ts`);
      fs.copyFileSync(filePath, backupPath);
      console.log(`[NPM] 旧插件已转移到缓存: ${backupPath}`);
    }
    
    // 清理旧的 .backup 文件（如果存在）
    if (fs.existsSync(oldBackupPath)) {
      fs.unlinkSync(oldBackupPath);
      console.log(`[NPM] 已清理旧备份文件: ${oldBackupPath}`);
    }
    
    // 保存插件文件
    fs.writeFileSync(filePath, response.data);
    await msg.edit({ text: `插件 ${plugin} 已安装并加载成功` });
    await loadPlugins(); // 重新加载插件
  } else {
    await msg.edit({ text: `无法获取远程插件库` });
  }
}

async function installAllPlugins(msg: Api.Message) {
  await msg.edit({ text: "🔍 正在获取远程插件列表..." });
  
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  try {
    const res = await axios.get(url);
    if (res.status !== 200) {
      await msg.edit({ text: "❌ 无法获取远程插件库" });
      return;
    }

    const plugins = Object.keys(res.data);
    const totalPlugins = plugins.length;
    
    if (totalPlugins === 0) {
      await msg.edit({ text: "📦 远程插件库为空" });
      return;
    }

    let installedCount = 0;
    let failedCount = 0;
    const failedPlugins: string[] = [];

    await msg.edit({ 
      text: `📦 开始安装 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`,
      parseMode: "html"
    });

    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = generateProgressBar(progress);
      
      try {
        // 更新进度显示
        await msg.edit({ 
          text: `📦 正在安装插件: <code>${plugin}</code>\n\n${progressBar}\n🔄 进度: ${i + 1}/${totalPlugins} (${progress}%)\n✅ 成功: ${installedCount}\n❌ 失败: ${failedCount}`,
          parseMode: "html"
        });

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

        // 检查插件是否已存在
        const filePath = path.join(PLUGIN_PATH, `${plugin}.ts`);
        const oldBackupPath = path.join(PLUGIN_PATH, `${plugin}.ts.backup`);
        
        if (fs.existsSync(filePath)) {
          // 将现有插件转移到缓存目录
          const cacheDir = createDirectoryInTemp('plugin_backups');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const backupPath = path.join(cacheDir, `${plugin}_${timestamp}.ts`);
          fs.copyFileSync(filePath, backupPath);
          console.log(`[NPM] 旧插件已转移到缓存: ${backupPath}`);
        }
        
        // 清理旧的 .backup 文件（如果存在）
        if (fs.existsSync(oldBackupPath)) {
          fs.unlinkSync(oldBackupPath);
          console.log(`[NPM] 已清理旧备份文件: ${oldBackupPath}`);
        }

        // 保存插件文件
        fs.writeFileSync(filePath, response.data);
        installedCount++;
        
        // 短暂延迟避免API限制
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${plugin} (${error})`);
        console.error(`[NPM] 安装插件 ${plugin} 失败:`, error);
      }
    }

    // 重新加载所有插件
    try {
      await loadPlugins();
    } catch (error) {
      console.error("[NPM] 重新加载插件失败:", error);
    }

    // 显示最终结果
    const successBar = generateProgressBar(100);
    let resultMsg = `🎉 <b>批量安装完成!</b>\n\n${successBar}\n\n📊 <b>安装统计:</b>\n✅ 成功安装: ${installedCount}/${totalPlugins}\n❌ 安装失败: ${failedCount}/${totalPlugins}`;
    
    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).join('\n• ');
      const moreFailures = failedPlugins.length > 5 ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败` : '';
      resultMsg += `\n\n❌ <b>失败列表:</b>\n• ${failedList}${moreFailures}`;
    }
    
    resultMsg += `\n\n🔄 插件已重新加载，可以开始使用!`;
    
    await msg.edit({ 
      text: resultMsg,
      parseMode: "html"
    });
    
  } catch (error) {
    await msg.edit({ text: `❌ 批量安装失败: ${error}` });
    console.error("[NPM] 批量安装插件失败:", error);
  }
}

function generateProgressBar(percentage: number, length: number = 20): string {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `🔄 <b>进度条:</b> [${bar}] ${percentage}%`;
}

async function installPlugin(args: string[], msg: Api.Message) {
  if (args.length === 1) {
    if (msg.isReply) {
      const replied = await msg.getReplyMessage();
      if (replied?.media) {
        const fileName = await getMediaFileName(replied);
        const filePath = path.join(PLUGIN_PATH, fileName);
        await msg.client?.downloadMedia(replied, { outputFile: filePath });
        // 这里可以添加安装插件的逻辑
        await loadPlugins();
        await msg.edit({ text: `插件 ${fileName} 已安装并加载成功` });
      } else {
        await msg.edit({ text: "请回复一个插件文件" });
      }
    } else {
      await msg.edit({ text: "请回复某个插件文件或提供 npm 包名" });
    }
  } else {
    const packageName = args[1];
    if (packageName === "all") {
      await installAllPlugins(msg);
    } else {
      await installRemotePlugin(packageName, msg);
    }
  }
}

async function uninstallPlugin(plugin: string, msg: Api.Message) {
  if (!plugin) {
    await msg.edit({ text: "请提供要卸载的插件名称" });
    return;
  }
  const pluginPath = path.join(PLUGIN_PATH, `${plugin}.ts`);
  if (fs.existsSync(pluginPath)) {
    fs.unlinkSync(pluginPath);
    await msg.edit({ text: `插件 ${plugin} 已卸载` });
  } else {
    await msg.edit({ text: `未找到插件 ${plugin}` });
  }
  await loadPlugins(); // 重新加载插件
}

async function uploadPlugin(args: string[], msg: Api.Message) {
  const pluginName = args[1];
  if (!pluginName) {
    await msg.edit({ text: "请提供插件名称" });
    return;
  }
  const pluginPath = path.join(PLUGIN_PATH, `${pluginName}.ts`);
  if (!fs.existsSync(pluginPath)) {
    await msg.edit({ text: `未找到插件 ${pluginName}` });
    return;
  }
  await msg.client?.sendFile(msg.peerId, {
    file: pluginPath,
    thumb: path.join(process.cwd(), "telebox.png"),
    caption: `**TeleBox_Plugin ${pluginName} plugin.**`,
  });
  await msg.delete();
}

async function search(msg: Api.Message) {
  const url = `https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/plugins.json?raw=true`;
  
  try {
    await msg.edit({ text: "🔍 正在获取插件列表..." });
    
    const res = await axios.get(url);
    if (res.status !== 200) {
      await msg.edit({ text: `❌ 无法获取远程插件库` });
      return;
    }
    
    const remotePlugins = res.data;
    const pluginNames = Object.keys(remotePlugins);
    
    // 获取本地已安装的插件列表
    const installedPlugins = new Set<string>();
    try {
      const files = fs.readdirSync(PLUGIN_PATH);
      files.forEach(file => {
        if (file.endsWith('.ts') && !file.includes('backup')) {
          const pluginName = file.replace('.ts', '');
          installedPlugins.add(pluginName);
        }
      });
    } catch (error) {
      console.error("[NPM] 读取本地插件失败:", error);
    }
    
    // 统计信息
    const totalPlugins = pluginNames.length;
    const installedCount = pluginNames.filter(name => installedPlugins.has(name)).length;
    const notInstalledCount = totalPlugins - installedCount;
    
    // 生成插件列表，使用远程的描述信息
    const pluginList = pluginNames.map(plugin => {
      const isInstalled = installedPlugins.has(plugin);
      const status = isInstalled ? "☑️" : "❌";
      const pluginData = remotePlugins[plugin];
      const description = pluginData?.desc || "暂无描述";
      const author = pluginData?.author || "未知";
      
      // 格式化输出：状态图标 插件名 - 描述 (作者)
      return `${status} <code>${plugin}</code> - ${description} <i>(${author})</i>`;
    }).join("\n");
    
    // 生成统计信息
    const statsInfo = `📊 <b>插件统计:</b>\n` +
                     `• 总计: ${totalPlugins} 个插件\n` +
                     `• ☑️ 已安装: ${installedCount} 个\n` +
                     `• ❌ 未安装: ${notInstalledCount} 个`;
    
    const installTip = `\n💡 <b>安装方法:</b>\n` +
                      `• <code>npm i &lt;插件名&gt;</code> - 安装单个插件\n` +
                      `• <code>npm i all</code> - 一键安装全部远程插件\n` +
                      `• <code>npm rm &lt;插件名&gt;</code> - 卸载插件`;
    
    const repoLink = `\n🔗 <b>插件仓库:</b> <a href="https://github.com/TeleBoxDev/TeleBox_Plugins">TeleBox_Plugins</a>`;
    
    // 组装最终消息
    const message = `🔍 <b>远程插件列表:</b>\n\n` +
                   `${statsInfo}\n\n` +
                   `<b>插件详情:</b>\n${pluginList}\n` +
                   `${installTip}\n` +
                   `${repoLink}`;
    
    // 确保消息不超过Telegram限制（4096字符）
    if (message.length > 4000) {
      // 如果消息太长，截断插件列表
      const truncatedList = pluginNames.slice(0, 25).map(plugin => {
        const isInstalled = installedPlugins.has(plugin);
        const status = isInstalled ? "☑️" : "❌";
        const pluginData = remotePlugins[plugin];
        const description = pluginData?.desc || "暂无描述";
        return `${status} <code>${plugin}</code> - ${description}`;
      }).join("\n");
      
      const truncatedMessage = `🔍 <b>远程插件列表 (显示前25个):</b>\n\n` +
                              `${statsInfo}\n\n` +
                              `<b>插件详情:</b>\n${truncatedList}\n` +
                              `... 还有 ${totalPlugins - 25} 个插件\n` +
                              `${installTip}\n` +
                              `${repoLink}`;
      
      await msg.edit({ 
        text: truncatedMessage,
        parseMode: "html"
      });
    } else {
      await msg.edit({ 
        text: message,
        parseMode: "html"
      });
    }
    
  } catch (error) {
    console.error("[NPM] 搜索插件失败:", error);
    await msg.edit({ text: `❌ 搜索插件失败: ${error}` });
  }
}

const npmPlugin: Plugin = {
  command: ["npm"],
  description:
    `本地资源: 对某个文件回复 npm install\n` +
    `远程资源: npm install <plugin_name> || npm i <plugin_name>\n` +
    `批量安装: npm i all - 一键安装所有远程插件\n` +
    `卸载插件: npm remove <plugin_name> || npm rm <plugin_name> || npm un <plugin_name> || npm uninstall <plugin_name>
    `,
  cmdHandler: async (msg) => {
    const text = msg.message;
    const [, ...args] = text.split(" ");
    if (args.length === 0) {
      await msg.edit({ text: "请输入完整指令" });
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
      await uninstallPlugin(args[1], msg);
    } else if (cmd == "upload") {
      await uploadPlugin(args, msg);
    } else if (cmd === "search") {
      await search(msg);
    }
  },
};

export default npmPlugin;
