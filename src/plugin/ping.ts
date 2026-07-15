import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { Api } from "teleproto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createConnection } from "net";
import * as http from "http";
import * as https from "https";
import * as dns from "dns";

import { safeGetMe } from "../utils/authGuards";
import { htmlEscape } from "@utils/htmlEscape";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const execFileAsync = promisify(execFile);

type PingProxy =
  | {
      kind: "socks";
      host: string;
      port: number;
      version: 4 | 5;
      user?: string;
      password?: string;
    }
  | {
      kind: "http";
      host: string;
      port: number;
      user?: string;
      password?: string;
    };

function parseProxyUrl(raw: string): PingProxy | null {
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const port = Number(u.port || (u.protocol.startsWith("socks") ? 1080 : 8080));
    if (!host || !port) return null;
    const user = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    const proto = u.protocol.replace(":", "").toLowerCase();
    if (proto === "socks5" || proto === "socks5h" || proto === "socks") {
      return { kind: "socks", host, port, version: 5, user, password };
    }
    if (proto === "socks4" || proto === "socks4a") {
      return { kind: "socks", host, port, version: 4, user, password };
    }
    if (proto === "http" || proto === "https") {
      return { kind: "http", host, port, user, password };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 解析代理：优先 config.json（与 Telegram 客户端一致），
 * 其次 PM2/进程环境变量 ALL_PROXY / HTTPS_PROXY / HTTP_PROXY。
 */
async function resolvePingProxy(): Promise<PingProxy | null> {
  try {
    const { getApiConfig } = await import("@utils/apiConfig");
    const api = await getApiConfig();
    const p = api?.proxy as
      | {
          ip?: string;
          host?: string;
          hostname?: string;
          port?: number | string;
          socksType?: 4 | 5;
          type?: string;
          http?: boolean;
          MTProxy?: boolean;
          secret?: string;
          username?: string;
          user?: string;
          password?: string;
        }
      | undefined;
    if (p && !p.MTProxy && !p.secret) {
      const host = p.ip ?? p.host ?? p.hostname;
      const port = Number(p.port);
      if (host && port) {
        const user = p.username ?? p.user;
        const password = p.password;
        if (p.type === "http" || p.http) {
          return { kind: "http", host, port, user, password };
        }
        return {
          kind: "socks",
          host,
          port,
          version: p.socksType === 4 ? 4 : 5,
          user,
          password,
        };
      }
    }
  } catch {
    /* config 不可用时走环境变量 */
  }

  const envRaw =
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (envRaw) return parseProxyUrl(envRaw);
  return null;
}

function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * 经 SOCKS5 建立到目标的 TCP 连接（纯 Node，无额外依赖）
 */
function socks5Connect(
  proxy: Extract<PingProxy, { kind: "socks" }>,
  destHost: string,
  destPort: number,
  timeout: number,
): Promise<import("net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxy.port, proxy.host);
    let stage: "greeting" | "auth" | "reply" | "done" = "greeting";
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners("data");
      resolve(socket);
    };

    socket.setTimeout(timeout);
    socket.on("timeout", () => fail(new Error("proxy timeout")));
    socket.on("error", (e) => fail(e));
    socket.on("connect", () => {
      if (proxy.user) {
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === "greeting") {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) return fail(new Error("bad socks5 version"));
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0x02) {
            const user = Buffer.from(proxy.user || "", "utf8");
            const pass = Buffer.from(proxy.password || "", "utf8");
            const auth = Buffer.alloc(3 + user.length + pass.length);
            auth[0] = 0x01;
            auth[1] = user.length;
            user.copy(auth, 2);
            auth[2 + user.length] = pass.length;
            pass.copy(auth, 3 + user.length);
            stage = "auth";
            socket.write(auth);
            return;
          }
          if (method !== 0x00) return fail(new Error(`socks5 auth method ${method}`));
          stage = "reply";
          writeSocks5Request();
          return;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) return fail(new Error("socks5 auth failed"));
          buf = buf.subarray(2);
          stage = "reply";
          writeSocks5Request();
          return;
        }
        if (stage === "reply") {
          if (buf.length < 5) return;
          if (buf[0] !== 0x05) return fail(new Error("bad socks5 reply"));
          if (buf[1] !== 0x00) return fail(new Error(`socks5 connect status ${buf[1]}`));
          const atyp = buf[3];
          let need = 4;
          if (atyp === 0x01) need = 4 + 4 + 2;
          else if (atyp === 0x03) {
            if (buf.length < 5) return;
            need = 4 + 1 + buf[4] + 2;
          } else if (atyp === 0x04) need = 4 + 16 + 2;
          else return fail(new Error(`socks5 atyp ${atyp}`));
          if (buf.length < need) return;
          stage = "done";
          ok();
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });

    function writeSocks5Request() {
      let req: Buffer;
      if (isIPv4(destHost)) {
        const parts = destHost.split(".").map((x) => Number(x));
        req = Buffer.alloc(10);
        req[0] = 0x05;
        req[1] = 0x01;
        req[2] = 0x00;
        req[3] = 0x01;
        req[4] = parts[0];
        req[5] = parts[1];
        req[6] = parts[2];
        req[7] = parts[3];
        req.writeUInt16BE(destPort, 8);
      } else {
        const hostBuf = Buffer.from(destHost, "utf8");
        req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05;
        req[1] = 0x01;
        req[2] = 0x00;
        req[3] = 0x03;
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(destPort, 5 + hostBuf.length);
      }
      socket.write(req);
    }
  });
}

/**
 * 经 HTTP CONNECT 建立到目标的 TCP 连接
 */
function httpConnect(
  proxy: Extract<PingProxy, { kind: "http" }>,
  destHost: string,
  destPort: number,
  timeout: number,
): Promise<import("net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxy.port, proxy.host);
    let buf = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners("data");
      resolve(socket);
    };

    socket.setTimeout(timeout);
    socket.on("timeout", () => fail(new Error("proxy timeout")));
    socket.on("error", (e) => fail(e));
    socket.on("connect", () => {
      let req =
        `CONNECT ${destHost}:${destPort} HTTP/1.1\r\n` +
        `Host: ${destHost}:${destPort}\r\n`;
      if (proxy.user) {
        const token = Buffer.from(
          `${proxy.user}:${proxy.password || ""}`,
          "utf8",
        ).toString("base64");
        req += `Proxy-Authorization: Basic ${token}\r\n`;
      }
      req += `Proxy-Connection: keep-alive\r\n\r\n`;
      socket.write(req);
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("binary");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const head = buf.slice(0, idx);
      const m = head.match(/^HTTP\/\d\.\d\s+(\d+)/);
      if (!m) return fail(new Error("bad http proxy response"));
      const code = Number(m[1]);
      if (code < 200 || code >= 300) {
        return fail(new Error(`http proxy CONNECT ${code}`));
      }
      ok();
    });
  });
}

async function connectViaProxy(
  proxy: PingProxy,
  destHost: string,
  destPort: number,
  timeout: number,
): Promise<import("net").Socket> {
  if (proxy.kind === "socks") {
    if (proxy.version === 4) {
      // SOCKS4 简化：仅 IPv4、无用户名（或 userid）
      return new Promise((resolve, reject) => {
        if (!isIPv4(destHost)) {
          reject(new Error("socks4 needs IPv4"));
          return;
        }
        const socket = createConnection(proxy.port, proxy.host);
        let settled = false;
        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(e);
        };
        socket.setTimeout(timeout);
        socket.on("timeout", () => fail(new Error("proxy timeout")));
        socket.on("error", (e) => fail(e));
        socket.on("connect", () => {
          const parts = destHost.split(".").map((x) => Number(x));
          const user = Buffer.from(proxy.user || "", "utf8");
          const req = Buffer.alloc(9 + user.length);
          req[0] = 0x04;
          req[1] = 0x01;
          req.writeUInt16BE(destPort, 2);
          req[4] = parts[0];
          req[5] = parts[1];
          req[6] = parts[2];
          req[7] = parts[3];
          user.copy(req, 8);
          req[8 + user.length] = 0x00;
          socket.write(req);
        });
        let buf = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length < 8) return;
          if (buf[1] !== 0x5a) {
            fail(new Error(`socks4 status ${buf[1]}`));
            return;
          }
          if (settled) return;
          settled = true;
          socket.setTimeout(0);
          socket.removeAllListeners("data");
          resolve(socket);
        });
      });
    }
    return socks5Connect(proxy, destHost, destPort, timeout);
  }
  return httpConnect(proxy, destHost, destPort, timeout);
}


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
  // 与 tcpPing 相同：走 config.json / PM2 代理
  return tcpPing(hostname, port, timeout);
}

/**
 * TCP 连接测试：有代理时经 SOCKS/HTTP 代理（与 config.json / PM2 环境一致），否则直连。
 */
async function tcpPing(
  hostname: string,
  port: number = 80,
  timeout: number = 3000
): Promise<number> {
  const start = performance.now();
  try {
    const proxy = await resolvePingProxy();
    if (proxy) {
      const socket = await connectViaProxy(proxy, hostname, port, timeout);
      const end = performance.now();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return Math.round(end - start);
    }

    return await new Promise<number>((resolve) => {
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
  } catch {
    return -1;
  }
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
        `🌐 <b>DC${dc} (${dcLocation}):</b> <code>${tcp.avg}ms</code>`
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
        `🌐 <b>DC${dc} (${dcLocation}):</b> <code>${pingTime}ms</code>`
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

  description: string = `🏓 网络延迟测试工具\n\n• ${mainPrefix}ping - Telegram API延迟\n• ${mainPrefix}ping &lt;IP/域名&gt; - 目标延迟测试\n• ${mainPrefix}ping dc1-dc5 - 数据中心延迟\n• ${mainPrefix}ping all - 所有数据中心延迟`;
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
            text: `🏓 <b>Ping工具使用说明</b>\n\n<b>基础用法:</b>\n• <code>${mainPrefix}ping</code> - Telegram延迟测试\n• <code>${mainPrefix}ping all</code> - 所有数据中心延迟\n\n<b>网络测试:</b>\n• <code>${mainPrefix}ping 8.8.8.8</code> - IP地址ping\n• <code>${mainPrefix}ping google.com</code> - 域名ping\n• <code>${mainPrefix}ping dc1</code> - 指定数据中心\n\n<b>数据中心:</b>\n• DC1-DC5: 分别对应不同地区服务器\n\n💡 <i>支持 IP / 域名 / dc1-dc5；可走 config/PM2 代理</i>`,
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
          const proxyHint = (await resolvePingProxy())
            ? " via proxy"
            : "";
          results.push(
            `🏓 <b>延迟:</b> <code>${avgText}ms</code> (丢包: ${tcpProbe.loss}%${proxyHint})`
          );
        } else {
          try {
            const pingResult = await systemPing(testTarget, 3);
            if (pingResult.avg >= 0 && pingResult.loss < 100) {
              const avgText =
                pingResult.avg === 0 ? "<1" : pingResult.avg.toString();
              results.push(
                `🏓 <b>延迟:</b> <code>${avgText}ms</code> (丢包: ${pingResult.loss}%)`
              );
            } else {
              const httpResult = await httpPing(testTarget, false);
              if (httpResult > 0) {
                results.push(
                  `🏓 <b>延迟:</b> <code>${httpResult}ms</code>`
                );
              } else {
                results.push(`🏓 <b>连通性:</b> <code>不可达</code>`);
              }
            }
          } catch (_error: any) {
            const httpResult = await httpPing(testTarget, false);
            if (httpResult > 0) {
              results.push(
                `🏓 <b>延迟:</b> <code>${httpResult}ms</code>`
              );
            } else {
              results.push(`🏓 <b>网络测试:</b> <code>不可达</code>`);
            }
          }
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
