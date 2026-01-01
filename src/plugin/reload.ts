import { Plugin } from "@utils/pluginBase";
import { loadPlugins, clearPlugins, listCommands } from "@utils/pluginManager";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/globalClient";
import { exec } from "child_process";
import { promisify } from "util";
import { cronManager } from "@utils/cronManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execAsync = promisify(exec);
const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");

const editExitMsg = async () => {
  try {
    if (!fs.existsSync(exitFile)) return;
    
    const data = fs.readFileSync(exitFile, "utf-8");
    const { messageId, chatId, time } = JSON.parse(data);
    const client = await getGlobalClient();
    
    if (!client) {
      console.error("Global client not available for exit message editing");
      return;
    }
    
    let target;
    try {
      target = await client.getEntity(chatId);
    } catch (e) {
      // 尝试通过 getDialogs 获取实体缓存
      await client.getDialogs({ limit: 20 });
      try {
        target = await client.getEntity(chatId);
      } catch (innerE) {
        console.error("Failed to get entity for exit message:", innerE);
        fs.unlinkSync(exitFile); // 清理文件
        return;
      }
    }
    
    const elapsed = Date.now() - time;
    await client.editMessage(chatId, {
      message: messageId,
      text: `✅ 重启完成, 耗时 ${elapsed}ms`,
    });
    
    console.log(`[ExitMessage] Edited exit message in ${chatId}:${messageId}, elapsed: ${elapsed}ms`);
    fs.unlinkSync(exitFile);
  } catch (e) {
    console.error("Failed to edit exit message:", e);
    // 清理损坏的文件
    if (fs.existsSync(exitFile)) {
      fs.unlinkSync(exitFile);
    }
  }
};

// 启动时检查并编辑退出消息
if (fs.existsSync(exitFile)) {
  editExitMsg();
}

// 内存监控工具
class MemoryMonitor {
  private static lastMemoryUsage: NodeJS.MemoryUsage | null = null;
  
  static snapshot(): NodeJS.MemoryUsage {
    return process.memoryUsage();
  }
  
  static diff(): { 
    heapUsed: number; 
    heapTotal: number; 
    rss: number; 
    external: number 
  } | null {
    const current = this.snapshot();
    if (!this.lastMemoryUsage) {
      this.lastMemoryUsage = current;
      const heapUsedMB = current.heapUsed / 1024 / 1024;
      const heapTotalMB = current.heapTotal / 1024 / 1024;
      const rssMB = current.rss / 1024 / 1024;
      const externalMB = current.external / 1024 / 1024;
      
      console.log(`[MemoryMonitor] Initial memory: heapUsed=${heapUsedMB.toFixed(2)}MB, heapTotal=${heapTotalMB.toFixed(2)}MB, rss=${rssMB.toFixed(2)}MB, external=${externalMB.toFixed(2)}MB`);
      return null;
    }
    
    const diff = {
      heapUsed: current.heapUsed - this.lastMemoryUsage.heapUsed,
      heapTotal: current.heapTotal - this.lastMemoryUsage.heapTotal,
      rss: current.rss - this.lastMemoryUsage.rss,
      external: current.external - this.lastMemoryUsage.external
    };
    
    this.lastMemoryUsage = current;
    
    const heapUsedDiffMB = diff.heapUsed / 1024 / 1024;
    const heapTotalDiffMB = diff.heapTotal / 1024 / 1024;
    const rssDiffMB = diff.rss / 1024 / 1024;
    const externalDiffMB = diff.external / 1024 / 1024;
    
    console.log(`[MemoryMonitor] Memory diff: heapUsed=${heapUsedDiffMB >= 0 ? '+' : ''}${heapUsedDiffMB.toFixed(2)}MB, heapTotal=${heapTotalDiffMB >= 0 ? '+' : ''}${heapTotalDiffMB.toFixed(2)}MB, rss=${rssDiffMB >= 0 ? '+' : ''}${rssDiffMB.toFixed(2)}MB, external=${externalDiffMB >= 0 ? '+' : ''}${externalDiffMB.toFixed(2)}MB`);
    
    return diff;
  }
  
  static formatMemory(usage: NodeJS.MemoryUsage): string {
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    const heapTotalMB = usage.heapTotal / 1024 / 1024;
    const rssMB = usage.rss / 1024 / 1024;
    const externalMB = usage.external / 1024 / 1024;
    
    return `Heap Used: ${heapUsedMB.toFixed(2)}MB\n` +
           `Heap Total: ${heapTotalMB.toFixed(2)}MB\n` +
           `RSS: ${rssMB.toFixed(2)}MB\n` +
           `External: ${externalMB.toFixed(2)}MB`;
  }
  
  static async triggerGC() {
    if (typeof global.gc === 'function') {
      console.log('[MemoryMonitor] Triggering garbage collection');
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 100)); // 等待GC完成
    } else {
      console.warn('[MemoryMonitor] Garbage collection not available. Start Node.js with --expose-gc flag for full memory management.');
    }
  }
}

// 插件状态监控
class PluginMonitor {
  static getPluginStats() {
    return {
      activePlugins: listCommands().length,
      cronTasks: cronManager.getStats().totalTasks,
      memoryUsage: MemoryMonitor.snapshot()
    };
  }
  
  static formatStats(stats: ReturnType<typeof this.getPluginStats>): string {
    const memory = MemoryMonitor.formatMemory(stats.memoryUsage);
    
    return `📊 <b>当前系统状态:</b>\n\n` +
           `🔌 <b>活跃插件:</b> ${stats.activePlugins}\n` +
           `⏰ <b>Cron任务:</b> ${stats.cronTasks}\n\n` +
           `🧠 <b>内存使用:</b>\n${memory}`;
  }
}

class ReloadPlugin extends Plugin {
  name = "reload";
  description = `<code>${mainPrefix}reload</code> - 重新加载所有插件
<code>${mainPrefix}restart</code> - 通过PM2重启程序
<code>${mainPrefix}exit</code> - 结束进程 若配置了进程管理工具, 将自动重启
<code>${mainPrefix}mem</code> - 查看内存状态
<code>${mainPrefix}pmr</code> - 通过PM2重启程序(静默模式)`;
  
  cmdHandlers = {
    reload: async (msg: Api.Message) => {
      const startTime = Date.now();
      
      try {
        console.log('[ReloadPlugin] Starting reload process');
        
        // 显示开始消息
        await msg.edit({ 
          text: "🔄 <b>正在重新加载插件...</b>", 
          parseMode: "html" 
        });
        
        // 1. 记录内存使用
        const beforeMemory = MemoryMonitor.snapshot();
        const beforeStats = PluginMonitor.getPluginStats();
        
        // 2. 清理插件
        console.log('[ReloadPlugin] Clearing plugins...');
        await clearPlugins();
        
        // 3. 垃圾回收
        await MemoryMonitor.triggerGC();
        
        // 4. 重新加载插件
        console.log('[ReloadPlugin] Loading plugins...');
        const loadStartTime = Date.now();
        await loadPlugins();
        const loadTime = Date.now() - loadStartTime;
        
        // 5. 垃圾回收
        await MemoryMonitor.triggerGC();
        
        // 6. 获取重载后的统计
        const afterStats = PluginMonitor.getPluginStats();
        const afterMemory = MemoryMonitor.snapshot();
        
        // 7. 计算内存差异
        const memoryDiff = {
          heapUsed: afterMemory.heapUsed - beforeMemory.heapUsed,
          heapTotal: afterMemory.heapTotal - beforeMemory.heapTotal,
          rss: afterMemory.rss - beforeMemory.rss,
          external: afterMemory.external - beforeMemory.external
        };
        
        // 8. 构建完整结果
        const totalTime = Date.now() - startTime;
        const loadTimeText = loadTime > 1000 
          ? `${(loadTime / 1000).toFixed(2)}s` 
          : `${loadTime}ms`;
        
        const pluginCount = afterStats.activePlugins;
        
        let resultText = `✅ <b>插件已重新加载完成</b>\n\n`;
        resultText += `⏱️ <b>耗时:</b> ${totalTime}ms\n`;
        resultText += `📦 <b>加载插件:</b> ${pluginCount}\n`;
        resultText += `⚡ <b>加载时间:</b> ${loadTimeText}\n\n`;
        
        const heapUsedDiffMB = memoryDiff.heapUsed / 1024 / 1024;
        const heapTotalDiffMB = memoryDiff.heapTotal / 1024 / 1024;
        const rssDiffMB = memoryDiff.rss / 1024 / 1024;
        const externalDiffMB = memoryDiff.external / 1024 / 1024;
        
        resultText += `🧠 <b>内存变化:</b>\n`;
        resultText += `• Heap Used: ${heapUsedDiffMB >= 0 ? '+' : ''}${heapUsedDiffMB.toFixed(2)}MB\n`;
        resultText += `• Heap Total: ${heapTotalDiffMB >= 0 ? '+' : ''}${heapTotalDiffMB.toFixed(2)}MB\n`;
        resultText += `• RSS: ${rssDiffMB >= 0 ? '+' : ''}${rssDiffMB.toFixed(2)}MB\n`;
        resultText += `• External: ${externalDiffMB >= 0 ? '+' : ''}${externalDiffMB.toFixed(2)}MB\n`;
        
        // 检查内存泄漏
        if (heapUsedDiffMB > 5) { // 如果堆内存增加超过5MB
          resultText += `\n⚠️ <b>警告:</b> 检测到可能的内存泄漏！堆内存增加了 ${heapUsedDiffMB.toFixed(2)}MB`;
          console.warn(`[ReloadPlugin] Potential memory leak detected: heap used increased by ${heapUsedDiffMB.toFixed(2)}MB`);
        }
        
        await msg.edit({ text: resultText, parseMode: "html" });
        console.log(`[ReloadPlugin] Reload completed in ${totalTime}ms, plugins loaded: ${afterStats.activePlugins}`);
        
      } catch (error) {
        console.error("[ReloadPlugin] Plugin reload failed:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        const errorOutput = `❌ <b>插件重新加载失败</b>\n\n`;
        errorOutput += `🔧 <b>错误信息:</b> ${errorMessage}\n\n`;
        errorOutput += `📝 <b>建议:</b> 检查控制台日志获取详细信息`;
        
        await msg.edit({ text: errorOutput, parseMode: "html" });
      }
    },
    
    restart: async (msg: Api.Message) => {
      let output = "🔄 <b>正在通过PM2重启程序...</b>\n\n";
      output += `<i>程序将在几秒内重启完成</i>`;
      
      await msg.edit({ text: output, parseMode: "html" });
      
      try {
        console.log('[ReloadPlugin] Starting PM2 restart...');
        
        // 执行PM2重启命令
        await execAsync("pm2 restart telebox");
        
        // 保存消息用于重启后编辑
        const result = await msg.reply({
          message: `✅ <b>重启命令已执行</b>\n\n<i>等待程序重启...</i>`,
          parseMode: "html"
        });
        
        if (result) {
          fs.writeFileSync(
            exitFile,
            JSON.stringify({
              messageId: result.id,
              chatId: result.chatId || result.peerId,
              time: Date.now(),
            }),
            "utf-8"
          );
        }
        
        // 等待一小段时间确保消息保存
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 退出进程，PM2会自动重启
        process.exit(0);
      } catch (error) {
        console.error('[ReloadPlugin] PM2 restart failed:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        output = `❌ <b>PM2重启失败</b>\n\n`;
        output += `🔧 <b>错误信息:</b> ${errorMessage}\n\n`;
        output += `📝 <b>建议:</b> 确保PM2已安装并配置正确，应用名称为 'telebox'`;
        
        await msg.edit({ text: output, parseMode: "html" });
      }
    },
    
    exit: async (msg: Api.Message) => {
      let output = "🔄 <b>结束进程...</b>\n\n";
      output += `<i>若配置了进程管理工具, 将自动重启</i>`;
      
      await msg.edit({ text: output, parseMode: "html" });
      
      try {
        // 保存消息信息以便重启后编辑
        const msgData = {
          messageId: msg.id,
          chatId: msg.chatId || msg.peerId,
          time: Date.now(),
        };
        
        fs.writeFileSync(exitFile, JSON.stringify(msgData), "utf-8");
        
        console.log('[ReloadPlugin] Process exiting...');
        
        // 短暂延迟后退出
        setTimeout(() => {
          process.exit(0);
        }, 100);
      } catch (error) {
        console.error('[ReloadPlugin] Error during exit:', error);
        
        output = `❌ <b>退出失败</b>\n\n`;
        output += `🔧 <b>错误:</b> ${error instanceof Error ? error.message : String(error)}`;
        
        await msg.edit({ text: output, parseMode: "html" });
      }
    },
    
    mem: async (msg: Api.Message) => {
      try {
        const stats = PluginMonitor.getPluginStats();
        const statsText = PluginMonitor.formatStats(stats);
        
        // 添加内存变化信息
        const diff = MemoryMonitor.diff();
        let diffText = "";
        
        if (diff) {
          const heapUsedDiffMB = diff.heapUsed / 1024 / 1024;
          const heapTotalDiffMB = diff.heapTotal / 1024 / 1024;
          diffText = `\n\n📈 <b>内存变化:</b>\n`;
          diffText += `堆使用: ${heapUsedDiffMB >= 0 ? '+' : ''}${heapUsedDiffMB.toFixed(2)}MB\n`;
          diffText += `堆总量: ${heapTotalDiffMB >= 0 ? '+' : ''}${heapTotalDiffMB.toFixed(2)}MB`;
        }
        
        const finalText = statsText + diffText;
        await msg.edit({ text: finalText, parseMode: "html" });
      } catch (error) {
        console.error('[ReloadPlugin] Memory stats error:', error);
        
        const errorText = `❌ <b>获取内存状态失败</b>\n\n`;
        errorText += `🔧 <b>错误:</b> ${error instanceof Error ? error.message : String(error)}`;
        
        await msg.edit({ text: errorText, parseMode: "html" });
      }
    },
    
    pmr: async (msg: Api.Message) => {
      // 静默模式：删除消息后重启
      await msg.delete();
      
      setTimeout(async () => {
        try {
          console.log('[ReloadPlugin] Silent PM2 restart initiated');
          await execAsync("pm2 restart telebox");
        } catch (error) {
          console.error("PM2 restart failed:", error);
        }
      }, 500);
    },
  };
  
  async onLoad(): Promise<void> {
    console.log(`[${this.name}] Reload plugin loaded`);
  }
  
  async cleanup(): Promise<void> {
    console.log(`[${this.name}] Cleanup called - no external resources to clean up`);
  }
}

const reloadPlugin = new ReloadPlugin();
export default reloadPlugin;