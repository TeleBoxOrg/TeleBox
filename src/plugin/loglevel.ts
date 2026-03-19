import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { logger, LogLevel } from "@utils/logger";

import { getGlobalClient } from "@utils/globalClient";

class LogLevelPlugin extends Plugin {
  description = `📝 日志等级设置工具
  
<b>使用方法：</b>
• <code>.loglevel [等级]</code> - 设置日志等级
• <code>.loglevel</code> - 查看当前日志等级

<b>可用等级：</b>
• <code>debug</code> - 调试信息 (所有日志)
• <code>info</code> - 普通信息 (默认)
• <code>warning</code> - 警告及错误
• <code>error</code> - 仅错误
• <code>silent</code> - 静默模式`;

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
      case "debug":
        newLevel = LogLevel.DEBUG;
        break;
      case "info":
        newLevel = LogLevel.INFO;
        break;
      case "warning":
      case "warn":
        newLevel = LogLevel.WARNING;
        break;
      case "error":
      case "err":
        newLevel = LogLevel.ERROR;
        break;
      case "silent":
      case "off":
        newLevel = LogLevel.SILENT;
        break;
      default:
        await msg.edit({
          text: "❌ <b>无效的日志等级</b>\n\n" +
                "💡 可用等级：<code>debug</code>, <code>info</code>, <code>warning</code>, <code>error</code>, <code>silent</code>",
          parseMode: "html"
        });
        return;
    }

    await logger.setLevel(newLevel);
    
    // 尝试动态更新当前客户端的日志等级
    try {
        const client = await getGlobalClient();
        if (client) {
            client.setLogLevel(logger.getGramJSLogLevel() as any);
        }
    } catch (e) {
        // 忽略客户端尚未初始化的错误
    }

    await msg.edit({
      text: `✅ <b>日志等级已设置为：</b> <code>${logger.getLevelName(newLevel)}</code>\n` +
            `🔄 GramJS日志等级已同步更新`,
      parseMode: "html"
    });
  }
}

export default new LogLevelPlugin();
