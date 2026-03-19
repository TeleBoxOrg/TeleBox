import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "teleproto";
import { exec } from "child_process";
import { promisify } from "util";
import { createConnection } from "net";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import Database from "better-sqlite3";
import path from "path";
import { PromisedNetSockets } from "teleproto/extensions";
import * as dns from "dns";

const execAsync = promisify(exec);

// 数据中心IP地址映射 (参考PagerMaid-Modify)
const DCs = {
  1: "149.154.175.53", // DC1 Miami
  2: "149.154.167.51", // DC2 Amsterdam
  3: "149.154.175.100", // DC3 Miami
  4: "149.154.167.91", // DC4 Amsterdam
  5: "91.108.56.130", // DC5 Singapore (PagerMaid IP)
};

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * 使用Telegram网络栈的TCP连接测试
 */
async function telegramTcpPing(
  hostname: string,
  port: number = 80,
  timeout: number = 3000
): Promise<number> {
  return new Promise(async (resolve) => {
    try {
      const socket = new PromisedNetSockets();
      const start = performance.now();

      // 设置超时
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

/**
 * 传统TCP连接测试 - 备用方法
 */
async function tcpPing(
  hostname: string,
  port: number = 80,
  timeout: number = 3000
): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = createConnection(port, hostname);

    socket.setTimeout(timeout);

    socket.on("connect", () => {
      const end = performance.now();
      socket.end();
      resolve(Math.round(end - start));
    });

    function handleError() {
      socket.destroy();
      resolve(-1);
    }

    socket.on("timeout", handleError);
    socket.on("error", handleError);
  });
}

/**
 * HTTP请求延迟测试 - 模拟ping
 */
async function httpPing(
  hostname: string,
  useHttps: boolean = false
): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    const protocol = useHttps ? require("https") : require("http");
    const port = useHttps ? 443 : 80;

    const req = protocol.request(
      {
        hostname,
        port,
        path: "/",
        method: "HEAD",
        timeout: 5000,
        headers: {
          "User-Agent": "TeleBox-Ping/1.0",
        },
      },
      (res: any) => {
        const end = performance.now();
        req.destroy();
        resolve(Math.round(end - start));
      }
    );

    req.on("error", () => {
      resolve(-1);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(-1);
    });

    req.end();
  });
}

/**
 * DNS解析延迟测试
 */
async function dnsLookupTime(
  hostname: string
): Promise<{ time: number; ip: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    dns.lookup(hostname, (err, address) => {
      const end = performance.now();
      if (err) {
        resolve({ time: -1, ip: "" });
      } else {
        resolve({ time: Math.round(end - start), ip: address });
      }
    });
  });
}

/**
 * 系统ICMP ping命令 (Linux)
 */
async function systemPing(
  target: string,
  count: number = 3
): Promise<{ avg: number; loss: number; output: string }> {
  try {
    const pingCmd = `ping -c ${count} -W 5 ${target}`;
    const { stdout, stderr } = await execAsync(pingCmd, { timeout: 10000 });

    console.log(stdout);

    // 解析Linux ping结果
    let avgTime = -1;
    let packetLoss = 100;

    const avgMatch = stdout.match(/avg\/[^=]+=\s*?([0-9.]+)/);
    const lossMatch = stdout.match(/(\d+)% packet loss/);

    if (avgMatch) {
      avgTime = Math.round(parseFloat(avgMatch[1]));
    }
    if (lossMatch) {
      packetLoss = parseInt(lossMatch[1]);
    }

    return {
      avg: avgTime,
      loss: packetLoss,
      output: stdout,
    };
  } catch (error: any) {
    if (error.code === "ETIMEDOUT") {
      throw new Error("执行超时");
    } else if (error.killed) {
      throw new Error("命令被终止");
    } else {
      throw new Error(`Ping失败: ${error.message}`);
    }
  }
}

/**
 * 测试所有数据中心延迟 (Linux)
 */
async function pingDataCenters(): Promise<string[]> {
  const results: string[] = [];

  for (let dc = 1; dc <= 5; dc++) {
    const ip = DCs[dc as keyof typeof DCs];
    try {
      // Linux: 使用awk提取时间
      const { stdout } = await execAsync(
        `ping -c 1 ${ip} | awk -F 'time=' '/time=/ {print $2}' | awk '{print $1}'`
      );

      let pingTime = "0";
      try {
        pingTime = String(Math.round(parseFloat(stdout.trim())));
      } catch {
        pingTime = "0";
      }

      const dcLocation =
        dc === 1 || dc === 3
          ? "Miami"
          : dc === 2 || dc === 4
          ? "Amsterdam"
          : "Singapore";

      results.push(
        `🌐 <b>DC${dc} (${dcLocation}):</b> <code>${pingTime}ms</code>`
      );
    } catch (error) {
      const dcLocation =
        dc === 1 || dc === 3
          ? "Miami"
          : dc === 2 || dc === 4
          ? "Amsterdam"
          : "Singapore";
      results.push(`🌐 <b>DC${dc} (${dcLocation}):</b> <code>超时</code>`);
    }
  }

  return results;
}

/**
 * 解析ping目标
 */
function parseTarget(input: string): {
  type: "ip" | "domain" | "dc";
  value: string;
} {
  // 检查是否为数据中心
  if (/^dc[1-5]$/i.test(input)) {
    const dcNum = parseInt(input.slice(2)) as keyof typeof DCs;
    return { type: "dc", value: DCs[dcNum] };
  }

  // 检查是否为IP地址
  const ipRegex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipRegex.test(input)) {
    return { type: "ip", value: input };
  }

  // 默认为域名
  return { type: "domain", value: input };
}

class PingPlugin extends Plugin {
  description: string = `🏓 网络延迟测试工具\n\n• .ping - Telegram API延迟\n• .ping <IP/域名> - ICMP ping测试\n• .ping dc1-dc5 - 数据中心延迟\n• .ping all - 所有数据中心延迟`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ping: async (msg) => {
      const client = await getGlobalClient();

      if (!client) {
        await msg.edit({
          text: "❌ 客户端未初始化",
        });
        return;
      }

      try {
        const args = msg.message.split(" ").slice(1);
        const target = args[0]?.toLowerCase();

        // 无参数 - 基础Telegram延迟测试
        if (!target) {
          // 测量 Telegram API 延迟
          const apiStart = Date.now();
          await client.getMe();
          const apiEnd = Date.now();
          const apiLatency = apiEnd - apiStart;

          // 测量消息编辑延迟
          const msgStart = Date.now();
          await msg.edit({
            text: "🏓 Pong!",
          });
          const msgEnd = Date.now();
          const msgLatency = msgEnd - msgStart;

          // 显示结果
          await msg.edit({
            text: `🏓 <b>Pong!</b>

📡 <b>API延迟:</b> <code>${apiLatency}ms</code>
✏️ <b>消息延迟:</b> <code>${msgLatency}ms</code>

⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
            parseMode: "html",
          });
          return;
        }

        // 所有数据中心测试
        if (target === "all" || target === "dc") {
          await msg.edit({
            text: "🔍 正在测试所有数据中心延迟...",
          });

          const dcResults = await pingDataCenters();

          await msg.edit({
            text: `🌐 <b>Telegram数据中心延迟</b>\n\n${dcResults.join(
              "\n"
            )}\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
            parseMode: "html",
          });
          return;
        }

        // 帮助信息
        if (target === "help" || target === "h") {
          await msg.edit({
            text: `🏓 <b>Ping工具使用说明</b>\n\n<b>基础用法:</b>\n• <code>.ping</code> - Telegram延迟测试\n• <code>.ping all</code> - 所有数据中心延迟\n\n<b>网络测试:</b>\n• <code>.ping 8.8.8.8</code> - IP地址ping\n• <code>.ping google.com</code> - 域名ping\n• <code>.ping dc1</code> - 指定数据中心\n\n<b>数据中心:</b>\n• DC1-DC5: 分别对应不同地区服务器\n\n💡 <i>支持ICMP和TCP连接测试</i>`,
            parseMode: "html",
          });
          return;
        }

        // 网络目标测试
        await msg.edit({
          text: `🔍 正在测试 <code>${htmlEscape(target)}</code>...`,
          parseMode: "html",
        });

        const parsed = parseTarget(target);
        const testTarget = parsed.value;

        // 执行多种测试
        const results: string[] = [];

        // DNS解析测试
        const dnsResult = await dnsLookupTime(testTarget);
        if (dnsResult.time > 0) {
          results.push(
            `🔍 <b>DNS解析:</b> <code>${dnsResult.time}ms</code> → <code>${dnsResult.ip}</code>`
          );
        }

        // ICMP Ping测试（尝试但可能失败）
        try {
          const pingResult = await systemPing(testTarget, 3);
          if (pingResult.avg >= 0 && pingResult.loss < 100) {
            const avgText =
              pingResult.avg === 0 ? "<1" : pingResult.avg.toString();
            results.push(
              `🏓 <b>ICMP Ping:</b> <code>${avgText}ms</code> (丢包: ${pingResult.loss}%)`
            );
          } else {
            // ICMP失败，使用HTTP ping作为替代
            const httpResult = await httpPing(testTarget, false);
            if (httpResult > 0) {
              results.push(
                `🏓 <b>HTTP Ping:</b> <code>${httpResult}ms</code> (ICMP不可用)`
              );
            } else {
              results.push(`🏓 <b>ICMP Ping:</b> <code>不可用</code>`);
            }
          }
        } catch (error: any) {
          // ICMP失败，尝试HTTP ping
          const httpResult = await httpPing(testTarget, false);
          if (httpResult > 0) {
            results.push(
              `🏓 <b>HTTP Ping:</b> <code>${httpResult}ms</code> (ICMP受限)`
            );
          } else {
            results.push(`🏓 <b>网络测试:</b> <code>ICMP/HTTP均不可用</code>`);
          }
        }

        // 使用Telegram网络栈测试TCP连接
        const telegramTcp80 = await telegramTcpPing(testTarget, 80, 5000);
        const telegramTcp443 = await telegramTcpPing(testTarget, 443, 5000);

        // 如果Telegram网络栈失败，回退到传统方法
        const tcp80 =
          telegramTcp80 > 0
            ? telegramTcp80
            : await tcpPing(testTarget, 80, 5000);
        const tcp443 =
          telegramTcp443 > 0
            ? telegramTcp443
            : await tcpPing(testTarget, 443, 5000);

        if (tcp80 > 0) {
          const method = telegramTcp80 > 0 ? "TG" : "TCP";
          results.push(`🌐 <b>${method}连接 (80):</b> <code>${tcp80}ms</code>`);
        }

        if (tcp443 > 0) {
          const method = telegramTcp443 > 0 ? "TG" : "TCP";
          results.push(
            `🔒 <b>${method}连接 (443):</b> <code>${tcp443}ms</code>`
          );
        }

        // HTTPS请求测试（应用层延迟）
        const httpsResult = await httpPing(testTarget, true);
        if (httpsResult > 0) {
          results.push(`📡 <b>HTTPS请求:</b> <code>${httpsResult}ms</code>`);
        }

        if (results.length === 0) {
          results.push(`❌ 所有测试均失败，目标可能不可达`);
        }

        const targetType =
          parsed.type === "dc"
            ? "数据中心"
            : parsed.type === "ip"
            ? "IP地址"
            : "域名";

        // 构建显示文本，避免重复显示相同内容
        let displayText = `🎯 <b>${targetType}延迟测试</b>\n`;

        if (target === testTarget) {
          // 输入和目标相同时，只显示一次
          displayText += `<code>${htmlEscape(target)}</code>\n\n`;
        } else {
          // 输入和目标不同时（如dc1 → IP），显示映射关系
          displayText += `<code>${htmlEscape(
            target
          )}</code> → <code>${htmlEscape(testTarget)}</code>\n\n`;
        }

        await msg.edit({
          text: `${displayText}${results.join(
            "\n"
          )}\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
          parseMode: "html",
        });
      } catch (error: any) {
        await msg.edit({
          text: `❌ 测试失败: ${htmlEscape(error.message)}`,
          parseMode: "html",
        });
      }
    },
  };
}

export default new PingPlugin();
