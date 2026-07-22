/** 
 * TeleBox Panel — lightweight HTTP server (Node http, no express dep).
 * Serves WebApp static assets + JSON API + SSE.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";
import { logger } from "@utils/logger";
import { readDisplayVersion } from "@utils/teleboxInfoHelper";
import { listCommands } from "@utils/pluginManager";
import {
  readPanelConfig,
  updatePanelConfig,
  addPanelAdmin,
  removePanelAdmin,
  listPanelAdmins,
  maskToken,
} from "./configStore";
import {
  validateWebAppInitData,
  issueSessionToken,
  verifySessionToken,
  isPanelAdminUser,
} from "./auth";
import { getOwnerId } from "./owner";
import {
  listPanelSettingsProviders,
  getProviderSnapshot,
  applyProviderValues,
} from "./settingsRegistry";
import * as tpm from "./tpmService";
import * as help from "./helpService";
import type { PanelSession, PanelStatusSnapshot } from "./types";

const WEBAPP_DIR = path.join(__dirname, "webapp");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

type ApiResult = {
  status: number;
  body: unknown;
};

let server: http.Server | null = null;
let runningMeta: { host: string; port: number } | null = null;

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Telegram-Init-Data",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(data);
}

function sendText(
  res: http.ServerResponse,
  status: number,
  text: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 2_000_000) {
      throw new Error("request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("JSON body must be an object");
  }
  return data as Record<string, unknown>;
}

function getBearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function requireSession(
  req: http.IncomingMessage,
): Promise<PanelSession> {
  const token = getBearer(req);
  const session = await verifySessionToken(token);
  if (!session) {
    const err = new Error("未登录或会话已过期") as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  const gate = await isPanelAdminUser(session.userId);
  if (!gate.allowed) {
    const err = new Error(gate.reason || "无权限") as Error & {
      status?: number;
    };
    err.status = 403;
    throw err;
  }
  return session;
}

async function buildStatus(): Promise<PanelStatusSnapshot> {
  const cfg = await readPanelConfig();
  const ownerId = await getOwnerId();
  const { isBotRunning } = await import("./botService");
  return {
    enabled: cfg.enabled,
    botConfigured: !!cfg.botToken,
    botRunning: isBotRunning(),
    httpRunning: !!server?.listening,
    publicBaseUrl: cfg.publicBaseUrl,
    bind: `${cfg.bindHost}:${cfg.bindPort}`,
    adminCount: cfg.admins.length + (ownerId ? 1 : 0),
    ownerId,
    version: readDisplayVersion(),
    pluginCount: (await help.listLoadedPlugins()).length,
    commandCount: listCommands().length,
  };
}

async function routeApi(
  req: http.IncomingMessage,
  url: URL,
  method: string,
): Promise<ApiResult> {
  const p = url.pathname.replace(/\/+$/, "") || "/";

  // Auth: exchange Telegram initData → session token
  if (method === "POST" && p === "/api/auth/telegram") {
    const body = await parseJsonBody(req);
    const initData = String(body.initData || "");
    const cfg = await readPanelConfig();
    if (!cfg.enabled) return { status: 503, body: { error: "Panel 未启用" } };
    if (!cfg.botToken) {
      return { status: 503, body: { error: "未配置 Bot Token" } };
    }
    const result = validateWebAppInitData(initData, cfg.botToken);
    if (!result.ok) return { status: 401, body: { error: result.error } };
    const gate = await isPanelAdminUser(result.user.userId);
    if (!gate.allowed) {
      return { status: 403, body: { error: "你不是 Panel 管理员" } };
    }
    const token = await issueSessionToken(result.user);
    return {
      status: 200,
      body: {
        token,
        user: {
          id: result.user.userId,
          username: result.user.username,
          firstName: result.user.firstName,
          isOwner: gate.isOwner,
        },
        exp: result.user.exp,
      },
    };
  }

  // Public health (no auth) — minimal
  if (method === "GET" && p === "/api/health") {
    const cfg = await readPanelConfig();
    return {
      status: 200,
      body: {
        ok: true,
        enabled: cfg.enabled,
        name: cfg.displayName,
      },
    };
  }

  // Everything else requires session
  const session = await requireSession(req);

  if (method === "GET" && p === "/api/me") {
    const gate = await isPanelAdminUser(session.userId);
    return {
      status: 200,
      body: {
        id: session.userId,
        username: session.username,
        firstName: session.firstName,
        isOwner: gate.isOwner,
        exp: session.exp,
      },
    };
  }

  if (method === "GET" && p === "/api/status") {
    return { status: 200, body: await buildStatus() };
  }

  // ---- TPM ----
  if (method === "GET" && p === "/api/tpm/search") {
    const q = url.searchParams.get("q") || "";
    return { status: 200, body: await tpm.tpmSearch(q) };
  }
  if (method === "GET" && p === "/api/tpm/installed") {
    const verbose = url.searchParams.get("verbose") === "1";
    return { status: 200, body: await tpm.tpmListInstalled(verbose) };
  }
  if (method === "POST" && p === "/api/tpm/install") {
    const body = await parseJsonBody(req);
    const names = Array.isArray(body.names)
      ? body.names.map(String)
      : body.name
        ? [String(body.name)]
        : [];
    if (!names.length) return { status: 400, body: { error: "缺少 names" } };
    return { status: 200, body: await tpm.tpmInstall(names) };
  }
  if (method === "POST" && p === "/api/tpm/uninstall") {
    const body = await parseJsonBody(req);
    const names = Array.isArray(body.names)
      ? body.names.map(String)
      : body.name
        ? [String(body.name)]
        : [];
    if (!names.length) return { status: 400, body: { error: "缺少 names" } };
    return { status: 200, body: await tpm.tpmUninstall(names) };
  }
  if (method === "POST" && p === "/api/tpm/update") {
    return { status: 200, body: await tpm.tpmUpdateAll() };
  }
  if (method === "GET" && p === "/api/tpm/source") {
    return { status: 200, body: await tpm.tpmGetSource() };
  }
  if (method === "POST" && p === "/api/tpm/source") {
    const body = await parseJsonBody(req);
    if (body.action === "remove" || body.url === null || body.url === "") {
      await tpm.tpmClearSource();
      return { status: 200, body: await tpm.tpmGetSource() };
    }
    await tpm.tpmSetSource(String(body.url || ""));
    return { status: 200, body: await tpm.tpmGetSource() };
  }
  if (method === "GET" && p.startsWith("/api/tpm/source-file/")) {
    const name = decodeURIComponent(p.slice("/api/tpm/source-file/".length));
    return { status: 200, body: await tpm.tpmReadPluginSource(name) };
  }

  // ---- Help / plugins ----
  if (method === "GET" && p === "/api/help") {
    return { status: 200, body: await help.helpOverview() };
  }
  if (method === "GET" && p.startsWith("/api/help/")) {
    const command = decodeURIComponent(p.slice("/api/help/".length));
    const detail = await help.helpCommandDetail(command);
    if (!detail) return { status: 404, body: { error: "未找到命令" } };
    return { status: 200, body: detail };
  }
  if (method === "GET" && p === "/api/plugins") {
    return { status: 200, body: { items: await help.listLoadedPlugins() } };
  }

  // ---- Settings hooks ----
  if (method === "GET" && p === "/api/settings") {
    const list = listPanelSettingsProviders().map((x) => ({
      id: x.id,
      title: x.title,
      description: x.description,
      category: x.category || "其他",
      icon: x.icon || "⚙️",
    }));
    return { status: 200, body: { items: list } };
  }
  if (method === "GET" && p.startsWith("/api/settings/")) {
    const id = decodeURIComponent(p.slice("/api/settings/".length));
    return { status: 200, body: await getProviderSnapshot(id) };
  }
  if (method === "PUT" && p.startsWith("/api/settings/")) {
    const id = decodeURIComponent(p.slice("/api/settings/".length));
    const body = await parseJsonBody(req);
    const values = await applyProviderValues(id, body);
    return { status: 200, body: { ok: true, values } };
  }

  // ---- Admins (owner-preferred; any panel admin can list) ----
  if (method === "GET" && p === "/api/admins") {
    const ownerId = await getOwnerId();
    const admins = await listPanelAdmins();
    return {
      status: 200,
      body: {
        ownerId,
        admins,
      },
    };
  }
  if (method === "POST" && p === "/api/admins") {
    const gate = await isPanelAdminUser(session.userId);
    if (!gate.isOwner) {
      return { status: 403, body: { error: "仅 owner 可添加管理员" } };
    }
    const body = await parseJsonBody(req);
    const userId = Number(body.userId);
    const admins = await addPanelAdmin(userId, body.note ? String(body.note) : undefined);
    return { status: 200, body: { admins } };
  }
  if (method === "DELETE" && p.startsWith("/api/admins/")) {
    const gate = await isPanelAdminUser(session.userId);
    if (!gate.isOwner) {
      return { status: 403, body: { error: "仅 owner 可删除管理员" } };
    }
    const userId = Number(decodeURIComponent(p.slice("/api/admins/".length)));
    const admins = await removePanelAdmin(userId);
    return { status: 200, body: { admins } };
  }

  // ---- Panel config (owner) ----
  if (method === "GET" && p === "/api/config") {
    const cfg = await readPanelConfig();
    const { isTunnelRunning, getTunnelUrl } = await import("./cloudflareTunnel");
    return {
      status: 200,
      body: {
        enabled: cfg.enabled,
        botToken: maskToken(cfg.botToken),
        publicBaseUrl: cfg.publicBaseUrl,
        bindHost: cfg.bindHost,
        bindPort: cfg.bindPort,
        displayName: cfg.displayName,
        adminCount: cfg.admins.length,
        updatedAt: cfg.updatedAt,
        tunnelMode: cfg.tunnelMode,
        tunnelUrl: cfg.tunnelUrl,
        tunnelRunning: isTunnelRunning(),
        tunnelCurrentUrl: getTunnelUrl(),
      },
    };
  }
  if (method === "PUT" && p === "/api/config") {
    const gate = await isPanelAdminUser(session.userId);
    if (!gate.isOwner) {
      return { status: 403, body: { error: "仅 owner 可修改 panel 配置" } };
    }
    const body = await parseJsonBody(req);
    if (typeof body.botToken === "string" && body.botToken.includes("••••")) {
      delete body.botToken;
    }
    const cfg = await updatePanelConfig(
      body as Parameters<typeof updatePanelConfig>[0],
    );
    const { applyPanelRuntimeFromConfig } = await import("./controller");
    await applyPanelRuntimeFromConfig();
    const { isTunnelRunning, getTunnelUrl } = await import("./cloudflareTunnel");
    return {
      status: 200,
      body: {
        enabled: cfg.enabled,
        botToken: maskToken(cfg.botToken),
        publicBaseUrl: cfg.publicBaseUrl,
        bindHost: cfg.bindHost,
        bindPort: cfg.bindPort,
        displayName: cfg.displayName,
        tunnelMode: cfg.tunnelMode,
        tunnelUrl: cfg.tunnelUrl,
        tunnelRunning: isTunnelRunning(),
        tunnelCurrentUrl: getTunnelUrl(),
      },
    };
  }

  return {
    status: 404,
    body: { error: `未知 API: ${method} ${p}`, user: session.userId },
  };
}

function safeJoin(base: string, rel: string): string | null {
  const target = path.normalize(path.join(base, rel));
  if (!target.startsWith(path.normalize(base + path.sep)) && target !== path.normalize(base)) {
    return null;
  }
  return target;
}

function serveStatic(
  res: http.ServerResponse,
  reqPath: string,
): void {
  let rel = reqPath === "/" ? "/index.html" : reqPath;
  // logo convenience
  if (rel === "/logo.png" || rel === "/logo-circle.png") {
    const candidates = [
      path.join(process.cwd(), "logo-circle.png"),
      path.join(process.cwd(), "telebox.png"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const buf = fs.readFileSync(c);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(buf);
        return;
      }
    }
  }

  const filePath = safeJoin(WEBAPP_DIR, rel.replace(/^\//, ""));
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    const index = path.join(WEBAPP_DIR, "index.html");
    if (fs.existsSync(index) && !rel.startsWith("/api")) {
      sendText(res, 200, fs.readFileSync(index, "utf-8"), MIME[".html"]);
      return;
    }
    sendText(res, 404, "Not Found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
  });
  res.end(buf);
}

async function handleTpmUpdateStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    await requireSession(req);
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    sendJson(res, err.status || 401, { error: err.message || "未授权" });
    return;
  }

  const { tpmUpdateEmitter, TPM_UPDATE_EVENT } = tpm;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("event: connected\ndata: {}\n\n");

  const onProgress = (data: unknown) => {
    try {
      res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* ignore */
    }
  };
  tpmUpdateEmitter.on(TPM_UPDATE_EVENT, onProgress);

  const cleanup = () => {
    tpmUpdateEmitter.off(TPM_UPDATE_EVENT, onProgress);
  };
  req.on("close", cleanup);

  try {
    await tpm.tpmUpdateAll();
    cleanup();
    try {
      res.write("event: done\ndata: {}\n\n");
      res.end();
    } catch {
      /* ignore */
    }
  } catch (err: unknown) {
    cleanup();
    const message = err instanceof Error ? err.message : String(err);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    } catch {
      /* ignore */
    }
  }
}

async function handler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const method = (req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Telegram-Init-Data",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      // SSE endpoint — handles its own response
      if (method === "GET" && url.pathname === "/api/tpm/update/stream") {
        await handleTpmUpdateStream(req, res);
        return;
      }
      try {
        const result = await routeApi(req, url, method);
        sendJson(res, result.status, result.body);
      } catch (e: unknown) {
        const err = e as Error & { status?: number };
        const status = err.status || 500;
        sendJson(res, status, {
          error: err.message || "internal error",
        });
      }
      return;
    }

    serveStatic(res, url.pathname);
  } catch (e: unknown) {
    logger.error("[panel-http] handler error", e);
    try {
      sendJson(res, 500, {
        error: e instanceof Error ? e.message : "internal error",
      });
    } catch {
      res.end();
    }
  }
}

export function isHttpRunning(): boolean {
  return !!(server && server.listening);
}

export function getHttpMeta(): { host: string; port: number } | null {
  return runningMeta;
}

export async function startHttpServer(
  host: string,
  port: number,
): Promise<void> {
  if (server) {
    await stopHttpServer();
  }
  await new Promise<void>((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handler(req, res);
    });
    s.once("error", reject);
    s.listen(port, host, () => {
      server = s;
      runningMeta = { host, port };
      logger.info(`[panel-http] listening on http://${host}:${port}`);
      resolve();
    });
  });
}

export async function stopHttpServer(): Promise<void> {
  const s = server;
  server = null;
  runningMeta = null;
  if (!s) return;
  await new Promise<void>((resolve) => {
    s.close(() => resolve());
    // Force close hang connections shortly
    setTimeout(() => resolve(), 2000).unref?.();
  });
  logger.info("[panel-http] stopped");
}
