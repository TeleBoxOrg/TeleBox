import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { Api } from "teleproto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createConnection } from "net";
import * as http from "http";
import * as https from "https";
import { PromisedNetSockets } from "teleproto/extensions";
import * as dns from "dns";

import { safeGetMe } from "../utils/authGuards";
import { htmlEscape } from "@utils/htmlEscape";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const execFileAsync = promisify(execFile);

// 数据中心IP地址映射 (参考PagerMaid-Modify)
const DCs = {
  1: "149.154.175.53", // DC1 Miami
  2: "149.154.167.51", // DC2 Amsterdam
  3: "149.154.175.100", // DC3 Miami
  4: "149.154.167.91", // DC4 Amsterdam
  5: "91.108.56.130", // DC5 Singapore (PagerMaid IP)
};

/**
 * 使用Telegram网络栈的TCP连接测试
 */
async function telegramTcpPing(
  hostname: string,
  port: number = 80,
  timeout: number = 3000
): Promise<number> {
  const socket = new PromisedNetSockets();
  try {
    const start = performance.now();

    const result = await Promise.race<number>([
      (async () => {
        await socket.connect(port, hostname);
        const end = performance.now();
        return Math.round(end - start);
      })(),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), timeout)),
    ]);

    return result;
  } catch {
    return -1;
  } finally {
    try { await socket.close(); } catch { /* ignore close errors */ }
  }
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
    const protocol = useHttps ? https : http;
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
      (res: http.IncomingMessage) => {
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
 * 单次 TCP 连接延迟（tcping）
 */
async function tcpingOnce(
  hostname: string,
  port: number,
  timeout: number = 3000,
): Promise<number> {
  return tcpPing(hostname, port, timeout);
}

/**
 * 多端口、多样本 TCP 探测。优先 443 → 80 → 22 → 53。
 * 不依赖系统 ping；全失败时返回 null，由调用方 fallback ICMP。
 */
async function tcpingProbe(
  hostname: string,
  ports: number[] = [443, 80, 22, 53],
  samples: number = 3,
  timeout: number = 3000,
): Promise<{ avg: number; port: number; loss: number; best: number } | null> {
  const ok: { ms: number; port: number }[] = [];
  let rounds = 0;
  for (let i = 0; i < samples; i++) {
    rounds++;
    let hit: { ms: number; port: number } | null = null;
    for (const port of ports) {
      const ms = await tcpingOnce(hostname, port, timeout);
      if (ms >= 0) {
        hit = { ms, port };
        break;
      }
    }
    if (hit) ok.push(hit);
  }
  if (ok.length === 0) return null;
  const avg = Math.round(ok.reduce((s, x) => s + x.ms, 0) / ok.length);
  const best = Math.min(...ok.map((x) => x.ms));
  const portCount = new Map<number, number>();
  for (const x of ok) portCount.set(x.port, (portCount.get(x.port) || 0) + 1);
  let port = ok[0].port;
  let maxC = 0;
  for (const [p, c] of portCount) {
    if (c > maxC) {
      maxC = c;
      port = p;
    }
  }
  const loss = Math.round(((rounds - ok.length) / rounds) * 100);
  return { avg, port, loss, best };
}

/**
 * 系统 ICMP ping（仅 TCP 失败时 fallback）
 */
async function systemPing(
  target: string,
  count: number = 3
): Promise<{ avg: number; loss: number; output: string }> {
  // Validate target; exec without a shell (no injection).
  if (!/^[A-Za-z0-9.\-_:]+$/.test(target)) {
    throw new Error("无效的 ping 目标");
  }
  const safeCount = Math.min(Math.max(Math.trunc(count) || 3, 1), 10);
  try {
    const { stdout } = await execFileAsync(
      "ping",
      ["-c", String(safeCount), "-W", "5", target],
      { timeout: 10000, shell: false }
    );

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
 * 测试所有数据中心延迟：TCP(443/80) 优先，失败再系统 ping
 */
async function pingDataCenters(): Promise<string[]> {
  const results: string[] = [];

  for (let dc = 1; dc <= 5; dc++) {
    const ip = DCs[dc as keyof typeof DCs];
    const dcLocation =
      dc === 1 || dc === 3
        ? "Miami"
        : dc === 2 || dc === 4
        ? "Amsterdam"
        : "Singapore";

    const tcp = await tcpingProbe(ip, [443, 80], 2, 3000);
    if (tcp) {
      results.push(
        `🌐 <b>DC${dc} (${dcLocation}):</b> <code>${tcp.avg}ms</code> <i>TCP:${tcp.port}</i>`
      );
      continue;
    }

    try {
      const { stdout } = await execFileAsync(
        "ping",
        ["-c", "1", "-W", "5", ip],
        { timeout: 10000, shell: false }
      );
      let pingTime = "0";
      const timeMatch = stdout.match(/time=([0-9.]+)/);
      if (timeMatch) {
        pingTime = String(Math.round(parseFloat(timeMatch[1])));
      }
      results.push(
        `🌐 <b>DC${dc} (${dcLocation}):</b> <code>${pingTime}ms</code> <i>ICMP</i>`
      );
    } catch (error) {
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

  description: string = `🏓 网络延迟测试工具\n\n• ${mainPrefix}ping - Telegram API延迟\n• ${mainPrefix}ping &lt;IP/域名&gt; - TCP 优先（fallback ICMP）\n• ${mainPrefix}ping dc1-dc5 - 数据中心延迟\n• ${mainPrefix}ping all - 所有数据中心延迟`;
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
          await safeGetMe(client);
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
            text: `🏓 <b>Ping工具使用说明</b>\n\n<b>基础用法:</b>\n• <code>${mainPrefix}ping</code> - Telegram延迟测试\n• <code>${mainPrefix}ping all</code> - 所有数据中心延迟\n\n<b>网络测试:</b>\n• <code>${mainPrefix}ping 8.8.8.8</code> - IP地址ping\n• <code>${mainPrefix}ping google.com</code> - 域名ping\n• <code>${mainPrefix}ping dc1</code> - 指定数据中心\n\n<b>数据中心:</b>\n• DC1-DC5: 分别对应不同地区服务器\n\n💡 <i>TCP(443/80) 优先，系统 ping 仅作 fallback</i>`,
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

        // TCP 优先（tcping），失败再系统 ICMP，再 HTTP
        const tcpProbe = await tcpingProbe(testTarget, [443, 80, 22, 53], 3, 3000);
        if (tcpProbe) {
          const avgText = tcpProbe.avg === 0 ? "<1" : String(tcpProbe.avg);
          results.push(
            `🏓 <b>TCP Ping:</b> <code>${avgText}ms</code> (port ${tcpProbe.port}, 丢包: ${tcpProbe.loss}%, best ${tcpProbe.best}ms)`
          );
        } else {
          try {
            const pingResult = await systemPing(testTarget, 3);
            if (pingResult.avg >= 0 && pingResult.loss < 100) {
              const avgText =
                pingResult.avg === 0 ? "<1" : pingResult.avg.toString();
              results.push(
                `🏓 <b>ICMP Ping:</b> <code>${avgText}ms</code> (TCP 不可用, 丢包: ${pingResult.loss}%)`
              );
            } else {
              const httpResult = await httpPing(testTarget, false);
              if (httpResult > 0) {
                results.push(
                  `🏓 <b>HTTP Ping:</b> <code>${httpResult}ms</code> (TCP/ICMP 不可用)`
                );
              } else {
                results.push(`🏓 <b>连通性:</b> <code>TCP/ICMP/HTTP 均不可用</code>`);
              }
            }
          } catch (_error: any) {
            const httpResult = await httpPing(testTarget, false);
            if (httpResult > 0) {
              results.push(
                `🏓 <b>HTTP Ping:</b> <code>${httpResult}ms</code> (TCP/ICMP 受限)`
              );
            } else {
              results.push(`🏓 <b>网络测试:</b> <code>TCP/ICMP/HTTP 均不可用</code>`);
            }
          }
        }

        // 补充端口明细
        const tcp80 = await tcpPing(testTarget, 80, 5000);
        const tcp443 = await tcpPing(testTarget, 443, 5000);
        if (tcp80 >= 0) {
          results.push(`🌐 <b>TCP:80:</b> <code>${tcp80}ms</code>`);
        }
        if (tcp443 >= 0) {
          results.push(`🔒 <b>TCP:443:</b> <code>${tcp443}ms</code>`);
        }

        // HTTPS 应用层
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
