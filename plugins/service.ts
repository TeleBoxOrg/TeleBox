import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Validate that a service name only contains characters allowed in systemd
 * unit names: ASCII letters, digits, hyphens, underscores, dots, and '@' (for
 * template instances).  Reject anything with shell metacharacters or path
 * separators to prevent command injection via the `.service <name>` command.
 */
function sanitizeServiceName(name: string): string | null {
  // systemd unit names allow: a-z A-Z 0-9 - _ . @ \  (no spaces, no /, no $, no ;, etc.)
  if (/^[a-zA-Z0-9_.@\\-]+$/.test(name)) {
    return name;
  }
  return null;
}

// 状态翻译映射
const STATUS_TRANSLATIONS: Record<string, string> = {
  "active (running)": "活跃 (运行中)",
  "inactive (dead)": "已停止 (未运行)",
  "failed": "失败",
  "activating": "启动中",
  "deactivating": "停止中",
  "Started:": "启动时间:",
  "Uptime:": "运行时间:",
  "Main PID:": "主进程PID:",
  "Tasks:": "任务数:",
  "Memory:": "内存:",
  "CPU:": "CPU使用:",
  "limit:": "限制:",
  "high:": "告警阈值:",
  "max:": "最大限制:",
  "available:": "可用:",
  "python3": "Python3",
  "systemd": "系统守护进程",
};

// 星期翻译映射
const WEEKDAY_MAP: Record<string, string> = {
  Mon: "周一",
  Tue: "周二", 
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
  Sun: "周日",
};

// 自动检测当前进程对应的systemd服务名称
async function getCurrentServiceName(): Promise<string> {
  try {
    const currentPid = String(process.pid);
    
    // 方法1：通过当前进程PID获取服务名称
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "unit=", "-p", currentPid]);
      if (stdout && stdout.trim() && !stdout.trim().startsWith("-")) {
        const unitName = stdout.trim();
        if (unitName.endsWith(".service")) {
          return unitName.slice(0, -8); // 移除.service后缀
        }
        return unitName;
      }
    } catch (error) {
      // 忽略错误，继续尝试其他方法
    }
    
    // 方法2：使用systemctl status PID
    try {
      const { stdout } = await execFileAsync("systemctl", ["status", currentPid]);
      if (stdout) {
        // 提取服务名称，格式类似: ● service-name.service - Description
        const match = stdout.match(/[●◯]\s*([^.\\s]+)/);
        if (match) {
          return match[1];
        }
      }
    } catch (error) {
      // 忽略错误，继续尝试其他方法
    }
    
    // 方法3：通过进程名称猜测（回退方案）
    try {
      // 检查常见的pagermaid服务名称
      const commonNames = ["pagermaid", "pgm", "pagermaid-modify", "pgm-sg", "pgm-hk"];
      for (const name of commonNames) {
        try {
          const { stdout } = await execFileAsync("systemctl", ["is-active", name]);
          if (stdout && stdout.includes("active")) {
            return name;
          }
        } catch (error) {
          // 继续检查下一个
        }
      }
    } catch (error) {
      // 忽略错误
    }
  } catch (error) {
    console.error("Error detecting service name:", error);
  }
  
  // 如果所有方法都失败，返回默认值
  return "pagermaid";
}

// 格式化时间为中文显示
function formatChineseTime(timeStr: string): string {
  try {
    // 匹配各种时间格式
    // 如: "Sat 2025-08-02 19:56:44 CST"
    const timePatterns = [
      /(\w+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\w+)/,
      /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/
    ];
    
    for (const pattern of timePatterns) {
      const match = timeStr.match(pattern);
      if (match) {
        if (match.length === 5) { // 有星期和时区
          const [, weekday, date, time, timezone] = match;
          const cnWeekday = WEEKDAY_MAP[weekday] || weekday;
          
          // 如果是CST，明确标注为北京时间
          if (timezone === "CST") {
            return `${cnWeekday} ${date} ${time} (北京时间)`;
          } else {
            return `${cnWeekday} ${date} ${time} (${timezone})`;
          }
        } else { // 只有日期时间
          const [, date, time] = match;
          return `${date} ${time} (北京时间)`;
        }
      }
    }
    
    // 如果匹配失败，返回原始字符串
    return timeStr;
  } catch (error) {
    return timeStr;
  }
}

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      }[m] || m)
  );

// 将系统状态信息翻译成中文
function translateToChinese(text: string): string {
  // 逐行处理
  const lines = text.split("\n");
  const translatedLines: string[] = [];
  
  for (const line of lines) {
    let translatedLine = line;
    
    // 首先处理时间格式
    if (line.includes("Started:") || line.includes("启动时间:")) {
      // 提取时间部分并格式化
      const timeMatch = line.match(/(启动时间:|Started:)\s*(.+)/);
      if (timeMatch) {
          const [, , timePart] = timeMatch;
        const formattedTime = formatChineseTime(timePart);
        translatedLine = `启动时间: ${formattedTime}`;
      }
    }
    
    // 应用其他翻译映射
    for (const [english, chinese] of Object.entries(STATUS_TRANSLATIONS)) {
      translatedLine = translatedLine.replace(english, chinese);
    }
    
    // 特殊处理时间单位
    translatedLine = translatedLine.replace(/(\d+)h/g, "$1小时");
    translatedLine = translatedLine.replace(/(\d+)min/g, "$1分钟");
    translatedLine = translatedLine.replace(/(\d+)s\b/g, "$1秒");
    translatedLine = translatedLine.replace(/(\d+\.\d+)s\b/g, "$1秒");
    
    // 内存单位翻译
    translatedLine = translatedLine.replace(/(\d+\.\d+)M\b/g, "$1MB");
    translatedLine = translatedLine.replace(/(\d+\.\d+)G\b/g, "$1GB");
    translatedLine = translatedLine.replace(/(\d+)M\b/g, "$1MB");
    translatedLine = translatedLine.replace(/(\d+)G\b/g, "$1GB");
    
    translatedLines.push(translatedLine);
  }
  
  return translatedLines.join("<br>");
}

// 获取机器人运行时间
function getBotUptime(): string {
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (seconds > 0) parts.push(`${seconds}秒`);
  
  return parts.join(" ") || "0秒";
}

// 主处理函数
async function handleServiceRequest(msg: Api.Message): Promise<void> {
  try {
    const args = msg.message.slice(1).split(" ").slice(1); // 移除命令名
    
    let serviceName: string;
    let isAutoDetected = false;
    
    if (args.length > 0) {
      // 用户指定了服务名称 — validate to prevent shell injection
      const validated = sanitizeServiceName(args[0]);
      if (!validated) {
        await msg.edit({ text: `❌ 服务名称包含非法字符，只允许字母、数字、-、_、.和@` });
        return;
      }
      serviceName = validated;
    } else {
      // 自动检测当前服务名称
      await msg.edit({ text: "🔍 正在自动检测当前服务..." });
      serviceName = await getCurrentServiceName();
      isAutoDetected = true;
    }
    
    // 显示正在查询的提示
    await msg.edit({ text: `🔍 正在检查 ${htmlEscape(serviceName)} 服务状态...` });
    
    try {
      // 获取完整的systemd状态信息，包括内存限制和告警阈值
      // Use execFile to avoid shell injection — serviceName is now validated,
      // and we pass args as an array instead of string interpolation.
      const { stdout: rawStatus } = await execFileAsync("systemctl", [
        "--no-pager", "status", serviceName,
      ]);
      
      // Filter lines locally instead of piping through shell
      const stdout = rawStatus
        .split("\n")
        .filter(line => /Active|PID|Tasks|Memory|CPU|limit|high|max|available/i.test(line) && !line.includes("grep"))
        .join("\n");
      
      if (stdout.includes("not be found") || stdout.includes("could not be found")) {
        await msg.edit({ text: `❌ 服务 '${serviceName}' 未找到。` });
        return;
      }
      
      if (stdout.includes("inactive")) {
        await msg.edit({ text: `🔴 服务 '${serviceName}' 已停止 (未运行)。` });
        return;
      }
      
      const lines = stdout.split("\n");
      const uptime = getBotUptime();
      
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        if (line.includes("Active:")) {
          line = line.replace("Active:", "").replace("ago", "").trim();
          const [beforeSince, afterSince] = line.split("since");
          
          if (afterSince) {
            const [sinceTime, uptimeInfo] = afterSince.split(";");
            lines[i] = `${beforeSince.trim()}<br>启动时间: ${sinceTime.trim()}<br>运行时间: ${uptimeInfo.trim()}`;
            
            // 如果是当前检测到的pagermaid服务，添加bot uptime
            if (isAutoDetected) {
              lines[i] += ` (${uptime})`;
            }
          }
        } else {
          lines[i] = line;
        }
      }
      
      let result = lines.join("<br>");
      
      // 翻译成中文
      result = translateToChinese(result);
      
      // 添加服务状态emoji和检测提示
      const statusEmoji = result.includes("活跃 (运行中)") ? "🟢" : "🟡";
      const detectionInfo = isAutoDetected ? " (自动检测)" : "";
      const escapedResult = htmlEscape(result.trim());
      const text = `${statusEmoji} <b>${htmlEscape(serviceName.charAt(0).toUpperCase() + serviceName.slice(1))} 服务详情${detectionInfo}</b><br><pre>${escapedResult}</pre>`;
      
      await msg.edit({ 
        text,
        parseMode: "html"
      });
      
    } catch (error: any) {
      await msg.edit({ text: `❌ 获取服务详情时发生错误: ${error.message}` });
    }
    
  } catch (error: any) {
    console.error("Service处理错误:", error);
    await msg.edit({ text: `❌ 错误：${error.message}` });
  }
}

class ServicePlugin extends Plugin {

  description: string = `
服务状态查看插件：
显示指定systemd服务的详细状态信息

使用方法：
• \`service\` - 自动检测并显示当前服务状态
• \`service &lt;服务名&gt;\` - 显示指定服务的状态

功能特点：
• 自动检测当前进程对应的systemd服务
• 中文状态信息翻译
• 显示服务运行时间、内存使用、CPU使用等详细信息
• 集成机器人运行时间显示
  `;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    service: handleServiceRequest,
  };
}

export default new ServicePlugin();
