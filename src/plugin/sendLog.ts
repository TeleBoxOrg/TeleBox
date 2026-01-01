import { Plugin } from "@utils/pluginBase";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { SendLogDB } from "@utils/sendLogDB";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

// 获取主前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 查找日志文件
async function findLogFiles(): Promise<{ outLog: string | null; errLog: string | null }> {
  const possiblePaths = [
    path.join(os.homedir(), ".pm2/logs/telebox-out.log"),
    path.join(os.homedir(), ".pm2/logs/telebox-error.log"),
    path.join(os.homedir(), ".pm2/logs/telebox-err.log"),
    path.join(process.cwd(), "logs/out.log"),
    path.join(process.cwd(), "logs/error.log"),
    path.join(process.cwd(), "logs/telebox.log"),
    "/var/log/telebox/out.log",
    "/var/log/telebox/error.log",
    "./logs/out.log",
    "./logs/error.log",
  ];

  let outLog: string | null = null;
  let errLog: string | null = null;

  for (const logPath of possiblePaths) {
    try {
      await fs.access(logPath);
      const fileName = path.basename(logPath).toLowerCase();
      if (fileName.includes("out") && !outLog) outLog = logPath;
      else if ((fileName.includes("err") || fileName.includes("error")) && !errLog) errLog = logPath;
    } catch {
      // 文件不存在，继续检查
    }
  }

  return { outLog, errLog };
}

class SendLogPlugin extends Plugin {
  name = "sendlog";
  description = `📤 发送日志文件插件

<b>📝 功能描述：</b>
• 查找并发送系统日志文件
• 支持发送输出日志和错误日志
• 自动设置日志发送目标
• 清理过大日志文件

<b>🔧 使用方法：</b>
• <code>${mainPrefix}sendlog</code> - 发送日志到默认目标（me）
• <code>${mainPrefix}sendlog set &lt;目标&gt;</code> - 设置发送目标
• <code>${mainPrefix}sendlog clean</code> - 清理日志文件

<b>💡 示例：</b>
• <code>${mainPrefix}sendlog set me</code> - 设置发送到收藏夹
• <code>${mainPrefix}sendlog set -100123456789</code> - 设置发送到指定频道
• <code>${mainPrefix}sendlog clean</code> - 清理日志文件释放空间

<b>📁 支持的日志路径：</b>
• ~/.pm2/logs/telebox-*.log
• ./logs/*.log
• /var/log/telebox/*.log`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sendlog: this.handleSendLog.bind(this),
    logs: this.handleSendLog.bind(this),
    log: this.handleSendLog.bind(this)
  };
  
  private activeTimers: NodeJS.Timeout[] = [];
  private dbConnections: SendLogDB[] = [];

  private async handleSendLog(msg: Api.Message): Promise<void> {
    const parts = msg.message.trim().split(/\s+/);
    
    // 设置目标
    if (parts.length >= 3 && parts[1] === "set") {
      const target = parts[2];
      if (!target) {
        await msg.edit({ text: "❌ 用法：.sendlog set <chatId|@用户名|me>", parseMode: "html" });
        return;
      }
      const db = new SendLogDB();
      this.dbConnections.push(db);
      db.setTarget(target);
      db.close();
      await msg.edit({ text: `✅ 已设置日志发送目标`, parseMode: "html" });
      return;
    }

    // 清理日志
    if (parts.length >= 2 && parts[1] === "clean") {
      await this.cleanLogs(msg);
      return;
    }

    // 发送日志
    let target = "me";
    try {
      const db = new SendLogDB();
      this.dbConnections.push(db);
      target = db.getTarget();
      db.close();
    } catch (error) {
      console.error("[SendLogPlugin] Error getting target:", error);
    }

    try {
      await msg.edit({ text: "🔍 正在搜索日志文件...", parseMode: "html" });
      const { outLog, errLog } = await findLogFiles();

      if (!outLog && !errLog) {
        await msg.edit({
          text: "❌ 未找到日志文件\n\n已检查路径：\n• ~/.pm2/logs/telebox-*.log\n• ./logs/*.log\n• /var/log/telebox/*.log\n\n建议：\n• 检查PM2进程状态\n• 确认日志文件路径",
          parseMode: "html"
        });
        return;
      }

      let sentCount = 0;
      const results: string[] = [];

      // 发送输出日志
      if (outLog) {
        try {
          const stats = await fs.stat(outLog);
          const sizeKB = Math.round(stats.size / 1024);
          if (stats.size > 50 * 1024 * 1024) {
            results.push(`⚠️ 输出日志过大（${sizeKB}KB），已跳过`);
          } else {
            await msg.client?.sendFile(target, {
              file: outLog,
              caption: `📄 输出日志（${sizeKB}KB）\n📁 <code>${outLog}</code>`,
              parseMode: "html"
            });
            results.push(`✅ 输出日志已发送（${sizeKB}KB）`);
            sentCount++;
          }
        } catch (error: any) {
          results.push(`❌ 输出日志发送失败：${htmlEscape(error.message?.substring(0, 50) || "未知错误")}`);
        }
      }

      // 发送错误日志
      if (errLog) {
        try {
          const stats = await fs.stat(errLog);
          const sizeKB = Math.round(stats.size / 1024);
          if (stats.size > 50 * 1024 * 1024) {
            results.push(`⚠️ 错误日志过大（${sizeKB}KB），已跳过`);
          } else {
            await msg.client?.sendFile(target, {
              file: errLog,
              caption: `🚨 错误日志（${sizeKB}KB）\n📁 <code>${errLog}</code>`,
              parseMode: "html"
            });
            results.push(`✅ 错误日志已发送（${sizeKB}KB）`);
            sentCount++;
          }
        } catch (error: any) {
          results.push(`❌ 错误日志发送失败：${htmlEscape(error.message?.substring(0, 50) || "未知错误")}`);
        }
      }

      const summaryText = [
        sentCount > 0 ? "📋 日志发送完成" : "⚠️ 日志发送失败",
        "",
        ...results,
        "",
        sentCount > 0 ? `📱 日志文件已发送到指定目标` : "💡 建议检查日志文件路径和权限"
      ].join("\n");

      await msg.edit({ text: summaryText, parseMode: "html" });
    } catch (error: any) {
      const errorMsg = error.message?.length > 100 ? error.message.substring(0, 100) + "..." : error.message;
      await msg.edit({
        text: `❌ 日志发送失败\n\n错误信息：${htmlEscape(errorMsg || "未知错误")}\n\n可能的解决方案：\n• 检查文件权限\n• 确认PM2进程状态\n• 重启telebox服务`,
        parseMode: "html"
      });
    }
  }

  private async cleanLogs(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔍 正在搜索日志文件...", parseMode: "html" });
    const { outLog, errLog } = await findLogFiles();

    if (!outLog && !errLog) {
      await msg.edit({
        text: "❌ 未找到日志文件\n\n已检查路径：\n• ~/.pm2/logs/telebox-*.log\n• ./logs/*.log\n• /var/log/telebox/*.log",
        parseMode: "html"
      });
      return;
    }

    const results: string[] = [];
    let cleanedCount = 0;

    if (outLog) {
      try {
        const stats = await fs.stat(outLog);
        const sizeKB = Math.round(stats.size / 1024);
        await fs.unlink(outLog);
        results.push(`✅ 已删除输出日志（${sizeKB}KB）`);
        cleanedCount++;
      } catch (error: any) {
        results.push(`❌ 删除输出日志失败：${htmlEscape(error.message?.substring(0, 50) || "未知错误")}`);
      }
    }

    if (errLog) {
      try {
        const stats = await fs.stat(errLog);
        const sizeKB = Math.round(stats.size / 1024);
        await fs.unlink(errLog);
        results.push(`✅ 已删除错误日志（${sizeKB}KB）`);
        cleanedCount++;
      } catch (error: any) {
        results.push(`❌ 删除错误日志失败：${htmlEscape(error.message?.substring(0, 50) || "未知错误")}`);
      }
    }

    const summaryText = [
      cleanedCount > 0 ? "🗑️ 日志清理完成" : "⚠️ 日志清理失败",
      "",
      ...results,
      "",
      cleanedCount > 0 ? `📊 已清理 ${cleanedCount} 个日志文件` : "💡 建议检查日志文件路径和权限"
    ].join("\n");

    await msg.edit({ text: summaryText, parseMode: "html" });
  }
  
  async cleanup(): Promise<void> {
    try {
      for (const timer of this.activeTimers) {
        clearTimeout(timer);
      }
      this.activeTimers = [];
      
      for (const db of this.dbConnections) {
        try {
          db.close();
        } catch (e) {
          console.error("[SendLogPlugin] Error closing database:", e);
        }
      }
      this.dbConnections = [];
      
      console.log("[SendLogPlugin] Cleanup completed");
    } catch (error) {
      console.error("[SendLogPlugin] Error during cleanup:", error);
    }
  }
}

export default new SendLogPlugin();