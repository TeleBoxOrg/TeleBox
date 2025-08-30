import { Plugin } from "@utils/pluginBase";
import os from "os";
import path from "path";
import fs from "fs/promises";

async function findLogFiles(): Promise<{ outLog: string | null; errLog: string | null }> {
  const possiblePaths = [
    // PM2 默认路径
    path.join(os.homedir(), ".pm2/logs/telebox-out.log"),
    path.join(os.homedir(), ".pm2/logs/telebox-error.log"),
    path.join(os.homedir(), ".pm2/logs/telebox-err.log"),
    // 项目本地路径
    path.join(process.cwd(), "logs/out.log"),
    path.join(process.cwd(), "logs/error.log"),
    path.join(process.cwd(), "logs/telebox.log"),
    // 系统日志路径
    "/var/log/telebox/out.log",
    "/var/log/telebox/error.log",
    // 相对路径
    "./logs/out.log",
    "./logs/error.log"
  ];

  let outLog: string | null = null;
  let errLog: string | null = null;

  for (const logPath of possiblePaths) {
    try {
      await fs.access(logPath);
      const fileName = path.basename(logPath).toLowerCase();
      
      if (fileName.includes('out') && !outLog) {
        outLog = logPath;
      } else if ((fileName.includes('err') || fileName.includes('error')) && !errLog) {
        errLog = logPath;
      }
    } catch {
      // 文件不存在，继续检查下一个
    }
  }

  return { outLog, errLog };
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const sendLogPlugin: Plugin = {
  command: ["sendlog", "logs", "log"],
  description: "发送日志文件到收藏夹",
  cmdHandler: async (msg) => {
    console.log('SendLog plugin triggered');
    
    try {
      // 简化初始响应
      await msg.edit({ text: "🔍 正在搜索日志文件..." });
      
      const { outLog, errLog } = await findLogFiles();
      console.log('Found logs:', { outLog, errLog });
      
      if (!outLog && !errLog) {
        await msg.edit({
          text: "❌ 未找到日志文件\n\n已检查路径:\n• ~/.pm2/logs/telebox-*.log\n• ./logs/*.log\n• /var/log/telebox/*.log\n\n建议:\n• 检查PM2进程状态\n• 确认日志文件路径"
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
          console.log(`Sending output log: ${outLog} (${sizeKB}KB)`);
          
          if (stats.size > 50 * 1024 * 1024) {
            results.push(`⚠️ 输出日志过大 (${sizeKB}KB)，已跳过`);
          } else {
            // 直接发送到当前对话，而不是"me"
            await msg.client?.sendFile(msg.chatId || "me", {
              file: outLog,
              caption: `📄 输出日志 (${sizeKB}KB)\n📁 ${outLog}`
            });
            results.push(`✅ 输出日志已发送 (${sizeKB}KB)`);
            sentCount++;
          }
        } catch (error: any) {
          console.error('Error sending output log:', error);
          results.push(`❌ 输出日志发送失败: ${error.message?.substring(0, 50) || '未知错误'}`);
        }
      }

      // 发送错误日志
      if (errLog) {
        try {
          const stats = await fs.stat(errLog);
          const sizeKB = Math.round(stats.size / 1024);
          console.log(`Sending error log: ${errLog} (${sizeKB}KB)`);
          
          if (stats.size > 50 * 1024 * 1024) {
            results.push(`⚠️ 错误日志过大 (${sizeKB}KB)，已跳过`);
          } else {
            // 直接发送到当前对话，而不是"me"
            await msg.client?.sendFile(msg.chatId || "me", {
              file: errLog,
              caption: `🚨 错误日志 (${sizeKB}KB)\n📁 ${errLog}`
            });
            results.push(`✅ 错误日志已发送 (${sizeKB}KB)`);
            sentCount++;
          }
        } catch (error: any) {
          console.error('Error sending error log:', error);
          results.push(`❌ 错误日志发送失败: ${error.message?.substring(0, 50) || '未知错误'}`);
        }
      }

      // 发送结果摘要
      const summaryText = [
        sentCount > 0 ? "📋 日志发送完成" : "⚠️ 日志发送失败",
        "",
        ...results,
        "",
        sentCount > 0 ? "📱 日志文件已发送到当前对话" : "💡 建议检查日志文件路径和权限"
      ].join('\n');

      await msg.edit({ text: summaryText });
      
    } catch (error: any) {
      console.error('SendLog plugin error:', error);
      const errorMsg = error.message?.length > 100 ? error.message.substring(0, 100) + '...' : error.message;
      await msg.edit({
        text: `❌ 日志发送失败\n\n错误信息: ${errorMsg || '未知错误'}\n\n可能的解决方案:\n• 检查文件权限\n• 确认PM2进程状态\n• 重启telebox服务`
      });
    }
  },
};

export default sendLogPlugin;
