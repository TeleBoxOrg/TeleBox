import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { logger, LogLevel } from "@utils/logger";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

class LogLevelPlugin extends Plugin {
  name = "loglevel";
  description = `📝 日志等级设置工具

<b>📝 功能描述：</b>
• 动态调整系统日志输出等级
• 同步更新 GramJS 客户端日志等级
• 实时生效，无需重启

<b>🔧 使用方法：</b>
• <code>${mainPrefix}loglevel</code> - 查看当前日志等级
• <code>${mainPrefix}loglevel [等级]</code> - 设置日志等级

<b>📊 可用等级：</b>
• <code>debug</code> - 调试信息（所有日志）
• <code>info</code> - 普通信息（默认）
• <code>warning</code> / <code>warn</code> - 警告及错误
• <code>error</code> / <code>err</code> - 仅错误
• <code>silent</code> / <code>off</code> - 静默模式

<b>💡 示例：</b>
• <code>${mainPrefix}loglevel debug</code> - 设置为调试模式
• <code>${mainPrefix}loglevel error</code> - 只显示错误信息`;

  cmdHandlers = {
    loglevel: this.handleLogLevel.bind(this)
  };

  private async handleLogLevel(msg: Api.Message): Promise<void> {
    const text = (msg.text || "").trim();
    const parts = text.split(/\s+/);
    
    // 查看当前等级
    if (parts.length === 1) {
      const currentLevel = logger.getLevel();
      const levelName = logger.getLevelName(currentLevel);
      await msg.edit({
        text: `📋 <b>当前日志等级：</b> <code>${levelName}</code>`,
        parseMode: "html"
      });
      return;
    }

    // 设置等级
    const levelStr = parts[1].toLowerCase();
    let newLevel: LogLevel;

    switch (levelStr) {
      case "debug": newLevel = LogLevel.DEBUG; break;
      case "info": newLevel = LogLevel.INFO; break;
      case "warning":
      case "warn": newLevel = LogLevel.WARNING; break;
      case "error":
      case "err": newLevel = LogLevel.ERROR; break;
      case "silent":
      case "off": newLevel = LogLevel.SILENT; break;
      default:
        await msg.edit({
          text: `❌ <b>无效的日志等级</b>\n\n💡 可用等级：<code>debug</code>、<code>info</code>、<code>warning</code>、<code>error</code>、<code>silent</code>`,
          parseMode: "html"
        });
        return;
    }

    await logger.setLevel(newLevel);
    
    // 尝试同步更新 GramJS 客户端日志等级
    try {
      const client = await getGlobalClient();
      if (client) {
        client.setLogLevel(logger.getGramJSLogLevel() as any);
      }
    } catch (e) {
      // 忽略客户端尚未初始化的错误
    }

    await msg.edit({
      text: `✅ <b>日志等级已设置为：</b> <code>${logger.getLevelName(newLevel)}</code>\n🔄 GramJS日志等级已同步更新`,
      parseMode: "html"
    });
  }
  
  async cleanup(): Promise<void> {
    // Logger 是全局单例，不需要在插件中清理
    console.log("[LogLevelPlugin] Cleanup completed");
  }
}

export default new LogLevelPlugin();