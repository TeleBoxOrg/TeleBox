import { Plugin } from "@utils/pluginBase";
import { loadPlugins, clearPlugins, listCommands } from "@utils/pluginManager";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient, getEventHandlerStats } from "@utils/globalClient";
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
    const data = fs.readFileSync(exitFile, "utf-8");
    const { messageId, chatId, time } = JSON.parse(data);
    const client = await getGlobalClient();
    if (client) {
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
          return;
        }
      }
      await client.editMessage(chatId, {
        message: messageId,
        text: `✅ 重启完成, 耗时 ${Date.now() - time}ms`,
      });
      fs.unlinkSync(exitFile);
    }
  } catch (e) {
    console.error("Failed to edit exit message:", e);
  }
};

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
      
      console.log(`[MemoryMonitor] Initial memory usage: heapUsed=${heapUsedMB.toFixed(2)}MB, heapTotal=${heapTotalMB.toFixed(2)}MB, rss=${rssMB.toFixed(2)}MB, external=${externalMB.toFixed(2)}MB`);
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
    
    console.log(`[MemoryMonitor] Memory diff: heapUsed=${heapUsedDiffMB.toFixed(2)}MB, heapTotal=${heapTotalDiffMB.toFixed(2)}MB, rss=${rssDiffMB.toFixed(2)}MB, external=${externalDiffMB.toFixed(2)}MB`);
    
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
    // 获取事件处理器统计
    const eventHandlerStats = getEventHandlerStats();
    
    return {
      activePlugins: listCommands().length, // 使用命令数量作为活跃插件的近似值
      eventHandlersCount: eventHandlerStats.total,
      cronTasks: cronManager.getStats().totalTasks,
      memoryUsage: MemoryMonitor.snapshot()
    };
  }
  
  static formatStats(stats: ReturnType<typeof this.getPluginStats>): string {
    const memory = MemoryMonitor.formatMemory(stats.memoryUsage);
    
    return `📊 <b>当前系统状态:</b>\n\n` +
           `🔌 <b>活跃插件:</b> ${stats.activePlugins}\n` +
           `🎯 <b>事件处理器:</b> ${stats.eventHandlersCount}\n` +
           `⏰ <b>Cron任务:</b> ${stats.cronTasks}\n\n` +
           `🧠 <b>内存使用:</b>\n${memory}`;
  }
}

class ReloadPlugin extends Plugin {
  description:
    | string
    | (() => string)
    | (() => Promise<string>) = `<code>${mainPrefix}reload</code> - 重新加载所有插件
<code>${mainPrefix}exit</code> - 结束进程 若配置了进程管理工具, 将自动重启
<code>${mainPrefix}mem</code> - 查看内存状态`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    reload: async (msg) => {
      await msg.edit({ text: "🔄 <b>正在重新加载插件...</b>", parseMode: "html" });
      
      try {
        console.log('[ReloadPlugin] Starting reload process');
        
        // 1. 记录内存使用
        const beforeMemory = MemoryMonitor.snapshot();
        
        // 2. 获取重载前的统计
        const beforeStats = PluginMonitor.getPluginStats();
        console.log('[ReloadPlugin] Before reload stats:', beforeStats);
        
        // 3. 清理插件
        console.log('[ReloadPlugin] Clearing plugins...');
        await clearPlugins();
        
        // 4. 垃圾回收
        await MemoryMonitor.triggerGC();
        
        // 5. 重新加载插件
        console.log('[ReloadPlugin] Loading plugins...');
        const startTime = Date.now();
        await loadPlugins();
        const loadTime = Date.now() - startTime;
        
        // 6. 垃圾回收
        await MemoryMonitor.triggerGC();
        
        // 7. 获取重载后的统计
        const afterStats = PluginMonitor.getPluginStats();
        const afterMemory = MemoryMonitor.snapshot();
        
        // 8. 计算内存差异
        const memoryDiff = {
          heapUsed: afterMemory.heapUsed - beforeMemory.heapUsed,
          heapTotal: afterMemory.heapTotal - beforeMemory.heapTotal,
          rss: afterMemory.rss - beforeMemory.rss,
          external: afterMemory.external - beforeMemory.external
        };
        
        // 9. 格式化结果
        const loadTimeText = loadTime > 1000 
          ? `${(loadTime / 1000).toFixed(2)}s` 
          : `${loadTime}ms`;
        
        const pluginCount = afterStats.activePlugins;
        const eventHandlersCount = afterStats.eventHandlersCount;
        
        let resultText = `✅ <b>插件已重新加载完成</b>\n\n` +
                         `⏱️ <b>耗时:</b> ${loadTimeText}\n` +
                         `🔌 <b>加载插件:</b> ${pluginCount}\n` +
                         `🎯 <b>事件处理器:</b> ${eventHandlersCount}`;
        
        const heapUsedDiffMB = memoryDiff.heapUsed / 1024 / 1024;
        const heapTotalDiffMB = memoryDiff.heapTotal / 1024 / 1024;
        
        resultText += `\n\n🧠 <b>内存变化:</b>\n` +
                      `Heap Used: ${heapUsedDiffMB >= 0 ? '+' : ''}${heapUsedDiffMB.toFixed(2)}MB\n` +
                      `Heap Total: ${heapTotalDiffMB >= 0 ? '+' : ''}${heapTotalDiffMB.toFixed(2)}MB`;
        
        // 检查内存泄漏
        if (heapUsedDiffMB > 5) { // 如果堆内存增加超过5MB
          resultText += `\n\n⚠️ <b>警告:</b> 检测到可能的内存泄漏！堆内存增加了 ${heapUsedDiffMB.toFixed(2)}MB`;
          console.warn(`[ReloadPlugin] Potential memory leak detected: heap used increased by ${heapUsedDiffMB.toFixed(2)}MB`);
        }
        
        await msg.edit({ text: resultText, parseMode: "html" });
        
        console.log('[ReloadPlugin] Reload completed successfully');
      } catch (error) {
        console.error("Plugin reload failed:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        await msg.edit({
          text: `❌ <b>插件重新加载失败</b>\n\n` +
                `🔧 <b>错误信息:</b> ${errorMessage}\n\n` +
                `📝 <b>建议:</b> 检查控制台日志获取详细信息`,
          parseMode: "html"
        });
      }
    },
    
    exit: async (msg) => {
      const result = await msg.edit({
        text: "🔄 <b>结束进程...</b>\n<i>若配置了进程管理工具, 将自动重启</i>",
        parseMode: "html"
      });
      
      try {
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
        
        console.log('[ReloadPlugin] Process exiting...');
        process.exit(0);
      } catch (error) {
        console.error('[ReloadPlugin] Error during exit:', error);
        await msg.edit({
          text: `❌ <b>退出失败</b>\n\n` +
                `🔧 <b>错误:</b> ${error instanceof Error ? error.message : String(error)}`,
          parseMode: "html"
        });
      }
    },
    
    mem: async (msg) => {
      const stats = PluginMonitor.getPluginStats();
      const statsText = PluginMonitor.formatStats(stats);
      
      await msg.edit({
        text: statsText,
        parseMode: "html"
      });
    },
    
    pmr: async (msg) => {
      await msg.delete();
      setTimeout(async () => {
        try {
          await execAsync("pm2 restart telebox");
        } catch (error) {
          console.error("PM2 restart failed:", error);
          // 可以发送错误消息，但原始消息已被删除
        }
      }, 500);
    },
  };
  
  async cleanup(): Promise<void> {
    console.log('[ReloadPlugin] Cleanup called - no resources to clean up');
    // 这个插件没有需要清理的外部资源
  }
}

const reloadPlugin = new ReloadPlugin();
export default reloadPlugin;