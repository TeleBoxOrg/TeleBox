import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "telegram";
import { exec } from "child_process";
import { promisify } from "util";
import { createConnection } from "net";
import { PromisedNetSockets } from "telegram/extensions";
import * as dns from "dns";
import { getPrefixes } from "@utils/pluginManager";

const execAsync = promisify(exec);
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

// 数据中心IP地址映射
const DCs = {
  1: "149.154.175.53",   // DC1 Miami
  2: "149.154.167.51",   // DC2 Amsterdam
  3: "149.154.175.100",  // DC3 Miami
  4: "149.154.167.91",   // DC4 Amsterdam
  5: "91.108.56.130",    // DC5 Singapore
};

// Telegram网络栈TCP连接测试
async function telegramTcpPing(hostname: string, port: number = 80, timeout: number = 3000): Promise<number> {
  return new Promise(async (resolve) => {
    try {
      const socket = new PromisedNetSockets();
      const start = performance.now();
      const timeoutId = setTimeout(() => {
        socket.close();
        resolve(-1);
      }, timeout);

      await socket.connect(port, hostname);
      const end = performance.now();
      clearTimeout(timeoutId);
      await socket.close();
      resolve(Math.round(end - start));
    } catch (error) {
      resolve(-1);
    }
  });
}

// 传统TCP连接测试（备用）
async function tcpPing(hostname: string, port: number = 80, timeout: number = 3000): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = createConnection(port, hostname);
    socket.setTimeout(timeout);

    socket.on("connect", () => {
      const end = performance.now();
      socket.end();
      resolve(Math.round(end - start));
    });

    const handleError = () => {
      socket.destroy();
      resolve(-1);
    };

    socket.on("timeout", handleError);
    socket.on("error", handleError);
  });
}

// DNS解析延迟测试
async function dnsLookupTime(hostname: string): Promise<{ time: number; ip: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    dns.lookup(hostname, (err, address) => {
      const end = performance.now();
      if (err) resolve({ time: -1, ip: "" });
      else resolve({ time: Math.round(end - start), ip: address });
    });
  });
}

// 系统ICMP ping命令（Linux）
async function systemPing(target: string, count: number = 3): Promise<{ avg: number; loss: number; output: string }> {
  try {
    const pingCmd = `ping -c ${count} -W 5 ${target}`;
    const { stdout, stderr } = await execAsync(pingCmd, { timeout: 10000 });

    let avgTime = -1, packetLoss = 100;
    const avgMatch = stdout.match(/avg\/[^=]+=\s*?([0-9.]+)/);
    const lossMatch = stdout.match(/(\d+)% packet loss/);

    if (avgMatch) avgTime = Math.round(parseFloat(avgMatch[1]));
    if (lossMatch) packetLoss = parseInt(lossMatch[1]);

    return { avg: avgTime, loss: packetLoss, output: stdout };
  } catch (error: any) {
    throw new Error(error.code === "ETIMEDOUT" ? "执行超时" : 
                    error.killed ? "命令被终止" : 
                    `Ping失败：${error.message}`);
  }
}

// 测试所有数据中心延迟
async function pingDataCenters(): Promise<string[]> {
  const results: string[] = [];
  for (let dc = 1; dc <= 5; dc++) {
    const ip = DCs[dc as keyof typeof DCs];
    try {
      const { stdout } = await execAsync(`ping -c 1 ${ip} | awk -F 'time=' '/time=/ {print $2}' | awk '{print $1}'`);
      let pingTime = "0";
      try {
        pingTime = String(Math.round(parseFloat(stdout.trim())));
      } catch {
        pingTime = "0";
      }
      const dcLocation = dc === 1 || dc === 3 ? "Miami" : dc === 2 || dc === 4 ? "Amsterdam" : "Singapore";
      results.push(`🌐 <b>DC${dc} (${dcLocation})：</b> <code>${pingTime}ms</code>`);
    } catch {
      const dcLocation = dc === 1 || dc === 3 ? "Miami" : dc === 2 || dc === 4 ? "Amsterdam" : "Singapore";
      results.push(`🌐 <b>DC${dc} (${dcLocation})：</b> <code>超时</code>`);
    }
  }
  return results;
}

// 解析ping目标
function parseTarget(input: string): { type: "ip" | "domain" | "dc"; value: string } {
  if (/^dc[1-5]$/i.test(input)) {
    const dcNum = parseInt(input.slice(2)) as keyof typeof DCs;
    return { type: "dc", value: DCs[dcNum] };
  }
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipRegex.test(input)) return { type: "ip", value: input };
  return { type: "domain", value: input };
}

class PingPlugin extends Plugin {
  name = "ping";
  description = `🏓 网络延迟测试工具

<b>📝 功能描述：</b>
• 测试Telegram API响应延迟
• 测试指定IP/域名的网络延迟
• 测试所有数据中心延迟（DC1-DC5）
• 支持ICMP、TCP、DNS、HTTPS多种测试方式

<b>🔧 使用方法：</b>
• <code>${mainPrefix}ping</code> - Telegram延迟测试
• <code>${mainPrefix}ping &lt;IP/域名&gt;</code> - 网络延迟测试
• <code>${mainPrefix}ping dc1-dc5</code> - 指定数据中心测试
• <code>${mainPrefix}ping all</code> - 所有数据中心延迟
• <code>${mainPrefix}ping help</code> - 显示帮助

<b>💡 示例：</b>
• <code>${mainPrefix}ping</code> - 测试API和消息延迟
• <code>${mainPrefix}ping 8.8.8.8</code> - 测试Google DNS
• <code>${mainPrefix}ping google.com</code> - 测试域名解析
• <code>${mainPrefix}ping dc5</code> - 测试新加坡数据中心`;

  private activeTimers: NodeJS.Timeout[] = [];

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ping: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      try {
        const args = msg.message.split(" ").slice(1);
        const target = args[0]?.toLowerCase();

        // 无参数 - 基础Telegram延迟测试
        if (!target) {
          const apiStart = Date.now();
          await client.getMe();
          const apiLatency = Date.now() - apiStart;

          const msgStart = Date.now();
          await msg.edit({ text: "🏓 Pong!", parseMode: "html" });
          const msgLatency = Date.now() - msgStart;

          await msg.edit({
            text: `🏓 <b>Pong!</b>\n\n📡 <b>API延迟：</b> <code>${apiLatency}ms</code>\n✏️ <b>消息延迟：</b> <code>${msgLatency}ms</code>\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
            parseMode: "html"
          });
          return;
        }

        // 所有数据中心测试
        if (target === "all" || target === "dc") {
          await msg.edit({ text: "🔍 正在测试所有数据中心延迟...", parseMode: "html" });
          const dcResults = await pingDataCenters();
          await msg.edit({
            text: `🌐 <b>Telegram数据中心延迟</b>\n\n${dcResults.join("\n")}\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
            parseMode: "html"
          });
          return;
        }

        // 帮助信息
        if (target === "help" || target === "h") {
          await msg.edit({ text: this.description, parseMode: "html" });
          return;
        }

        // 网络目标测试
        await msg.edit({
          text: `🔍 正在测试 <code>${htmlEscape(target)}</code>...`,
          parseMode: "html"
        });

        const parsed = parseTarget(target);
        const testTarget = parsed.value;
        const results: string[] = [];

        // DNS解析测试
        const dnsResult = await dnsLookupTime(testTarget);
        if (dnsResult.time > 0) {
          results.push(`🔍 <b>DNS解析：</b> <code>${dnsResult.time}ms</code> → <code>${dnsResult.ip}</code>`);
        }

        // ICMP Ping测试
        try {
          const pingResult = await systemPing(testTarget, 3);
          if (pingResult.avg >= 0 && pingResult.loss < 100) {
            const avgText = pingResult.avg === 0 ? "<1" : pingResult.avg.toString();
            results.push(`🏓 <b>ICMP Ping：</b> <code>${avgText}ms</code>（丢包：${pingResult.loss}%）`);
          } else {
            throw new Error("ICMP不可用");
          }
        } catch {
          // ICMP失败时显示不可用
          results.push(`🏓 <b>ICMP Ping：</b> <code>不可用</code>`);
        }

        // TCP连接测试
        const tcp80 = await telegramTcpPing(testTarget, 80, 5000);
        if (tcp80 > 0) results.push(`🌐 <b>连接 (80)：</b> <code>${tcp80}ms</code>`);

        const tcp443 = await telegramTcpPing(testTarget, 443, 5000);
        if (tcp443 > 0) results.push(`🔒 <b>连接 (443)：</b> <code>${tcp443}ms</code>`);

        if (results.length === 0) {
          results.push(`❌ 所有测试均失败，目标可能不可达`);
        }

        const targetType = parsed.type === "dc" ? "数据中心" : parsed.type === "ip" ? "IP地址" : "域名";
        
        await msg.edit({
          text: `🎯 <b>${targetType}延迟测试</b>\n<code>${htmlEscape(target)}</code>\n\n${results.join("\n")}\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
          parseMode: "html"
        });
      } catch (error: any) {
        await msg.edit({
          text: `❌ 测试失败：<code>${htmlEscape(error.message || String(error))}</code>`,
          parseMode: "html"
        });
      }
    }
  };
  
  async cleanup(): Promise<void> {
    try {
      // 清理所有活动定时器
      for (const timer of this.activeTimers) {
        clearTimeout(timer);
      }
      this.activeTimers = [];
      console.log("[PingPlugin] Cleanup completed");
    } catch (error) {
      console.error("[PingPlugin] Error during cleanup:", error);
    }
  }
}

export default new PingPlugin();