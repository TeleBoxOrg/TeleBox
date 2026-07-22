/**
 * TeleBox Panel — TPM service layer (no MessageContext dependency).
 * Mirrors full `.tpm` capability for the WebApp API.
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { loadPlugins } from "@utils/pluginManager";
import { logger } from "@utils/logger";
import type { TpmInstalledPlugin, TpmRemotePlugin } from "./types";
import { EventEmitter } from "events";

export const tpmUpdateEmitter = new EventEmitter();
export const TPM_UPDATE_EVENT = "progress";

const PLUGINS_INDEX_URL =
  "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Next-Plugins/main/plugins.json";
const PLUGIN_PATH = path.join(process.cwd(), "plugins");
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_HEADERS = {
  "User-Agent": "TeleBox-Panel-TPM/1.0",
  Accept: "application/json, text/plain, */*",
};

type RemotePluginInfo = { url: string; desc?: string; name?: string };
type RemotePluginsIndex = Record<string, RemotePluginInfo>;
interface PluginRecord {
  url: string;
  desc?: string;
  _updatedAt: number;
}
type Database = Record<string, PluginRecord>;

let opLock: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opLock.then(fn, fn);
  opLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function getCustomSourceConfigPath(): string {
  return path.join(createDirectoryInAssets("tpm"), "source.json");
}

async function getCustomSourceConfig(): Promise<{ url: string } | null> {
  try {
    const cfgPath = getCustomSourceConfigPath();
    if (!fs.existsSync(cfgPath)) return null;
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {
    return null;
  }
}

function convertGithubToRawPluginUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const [owner, repo, ...rest] = parts;
        const branch =
          rest.length >= 1 && rest[0] !== "blob" && rest[0] !== "tree"
            ? rest[0]
            : "main";
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/plugins.json`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

function normalizeGithubUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      // owner/repo/blob/branch/path -> raw
      if (parts.length >= 5 && parts[2] === "blob") {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

async function fetchWithRetry<T>(
  url: string,
  options?: { responseType?: "json" | "text" },
): Promise<{ status: number; data: T }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: DEFAULT_HEADERS,
        responseType: options?.responseType === "text" ? "text" : "json",
        validateStatus: () => true,
      });
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      return { status: res.status, data: res.data as T };
    } catch (e: unknown) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getMergedRemotePluginsIndex(): Promise<RemotePluginsIndex> {
  const merged: RemotePluginsIndex = {};
  try {
    const officialRes = await fetchWithRetry<RemotePluginsIndex>(PLUGINS_INDEX_URL);
    if (
      officialRes.status === 200 &&
      officialRes.data &&
      typeof officialRes.data === "object"
    ) {
      Object.assign(merged, officialRes.data);
    }
  } catch (error: unknown) {
    logger.info(
      `[panel-tpm] 官方源失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const customSource = await getCustomSourceConfig();
  if (customSource) {
    const rawUrl = convertGithubToRawPluginUrl(customSource.url);
    try {
      const customRes = await fetchWithRetry<RemotePluginsIndex>(rawUrl);
      if (
        customRes.status === 200 &&
        customRes.data &&
        typeof customRes.data === "object"
      ) {
        Object.assign(merged, customRes.data);
      }
    } catch (error: unknown) {
      logger.info(
        `[panel-tpm] 自定义源失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return merged;
}

async function getDatabase() {
  const dbPath = path.join(createDirectoryInAssets("tpm"), "plugins.json");
  return JSONFilePreset<Database>(dbPath, {});
}

function listLocalPluginFiles(): string[] {
  try {
    if (!fs.existsSync(PLUGIN_PATH)) return [];
    return fs
      .readdirSync(PLUGIN_PATH)
      .filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.includes("backup") &&
          !f.endsWith(".d.ts") &&
          !f.endsWith(".deployed"),
      )
      .map((f) => f.replace(/\.ts$/, ""));
  } catch {
    return [];
  }
}

async function rebuildPluginDb(
  db: Awaited<ReturnType<typeof getDatabase>>,
): Promise<number> {
  const local = new Set(listLocalPluginFiles());
  let catalog: RemotePluginsIndex = {};
  try {
    catalog = await getMergedRemotePluginsIndex();
  } catch {
    /* keep old */
  }
  const next: Database = {};
  for (const name of local) {
    const remote = catalog[name];
    const old = db.data[name];
    if (remote) {
      next[name] = {
        url: remote.url,
        desc: remote.desc,
        _updatedAt: old?._updatedAt || Date.now(),
      };
    } else if (old) {
      next[name] = old;
    }
  }
  db.data = next;
  await db.write();
  return Object.keys(next).length;
}

export async function tpmSearch(keyword = ""): Promise<{
  total: number;
  installed: number;
  localOnly: number;
  remoteOnly: number;
  items: TpmRemotePlugin[];
  customSource: string | null;
}> {
  const [catalog, db] = await Promise.all([
    getMergedRemotePluginsIndex(),
    getDatabase(),
  ]);
  const local = new Set(listLocalPluginFiles());
  const kw = keyword.trim().toLowerCase();
  const names = Object.keys(catalog).filter((name) => {
    if (!kw) return true;
    const desc = catalog[name]?.desc || "";
    return (
      name.toLowerCase().includes(kw) || desc.toLowerCase().includes(kw)
    );
  });

  let installed = 0;
  let localOnly = 0;
  let remoteOnly = 0;
  const items: TpmRemotePlugin[] = names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const info = catalog[name];
      const hasLocal = local.has(name);
      const hasDb = !!db.data[name];
      let status: TpmRemotePlugin["status"] = "remote";
      if (hasLocal && (hasDb || info)) {
        status = "installed";
        installed++;
      } else if (hasLocal) {
        status = "local";
        localOnly++;
      } else {
        remoteOnly++;
      }
      return {
        name,
        url: info?.url || "",
        desc: info?.desc || "暂无描述",
        status,
      };
    });

  // Include local-only plugins not in catalog
  for (const name of local) {
    if (catalog[name]) continue;
    if (kw && !name.toLowerCase().includes(kw)) continue;
    localOnly++;
    items.push({
      name,
      url: db.data[name]?.url || "",
      desc: db.data[name]?.desc || "本地插件",
      status: "local",
    });
  }

  const custom = await getCustomSourceConfig();
  return {
    total: items.length,
    installed,
    localOnly,
    remoteOnly,
    items,
    customSource: custom?.url || null,
  };
}

export async function tpmListInstalled(verbose = false): Promise<{
  count: number;
  items: TpmInstalledPlugin[];
}> {
  const db = await getDatabase();
  await rebuildPluginDb(db);
  const local = listLocalPluginFiles();
  const items: TpmInstalledPlugin[] = local
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const rec = db.data[name];
      const filePath = path.join(PLUGIN_PATH, `${name}.ts`);
      let fileSize: number | undefined;
      if (verbose && fs.existsSync(filePath)) {
        try {
          fileSize = fs.statSync(filePath).size;
        } catch {
          /* ignore */
        }
      }
      return {
        name,
        url: rec?.url,
        desc: rec?.desc,
        updatedAt: rec?._updatedAt,
        hasFile: fs.existsSync(filePath),
        fileSize,
      };
    });
  return { count: items.length, items };
}

async function downloadAndWritePlugin(
  name: string,
  url: string,
  desc?: string,
): Promise<void> {
  const pluginUrl = normalizeGithubUrl(url);
  const response = await fetchWithRetry<string>(pluginUrl, {
    responseType: "text",
  });
  if (response.status !== 200 || typeof response.data !== "string") {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }
  if (!fs.existsSync(PLUGIN_PATH)) {
    fs.mkdirSync(PLUGIN_PATH, { recursive: true });
  }
  const filePath = path.join(PLUGIN_PATH, `${name}.ts`);
  if (fs.existsSync(filePath)) {
    const cacheDir = createDirectoryInTemp("plugin_backups");
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    fs.copyFileSync(
      filePath,
      path.join(cacheDir, `${name}_${timestamp}.ts.bak`),
    );
  }
  const oldBackupPath = path.join(PLUGIN_PATH, `${name}.ts.backup`);
  if (fs.existsSync(oldBackupPath)) fs.unlinkSync(oldBackupPath);
  fs.writeFileSync(filePath, response.data, "utf-8");

  const db = await getDatabase();
  db.data[name] = {
    url,
    desc,
    _updatedAt: Date.now(),
  };
  await db.write();
}

export async function tpmInstall(
  names: string[],
): Promise<{ ok: string[]; failed: Array<{ name: string; error: string }> }> {
  return withLock(async () => {
    const catalog = await getMergedRemotePluginsIndex();
    const ok: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const targets =
      names.length === 1 && names[0].toLowerCase() === "all"
        ? Object.keys(catalog)
        : names;

    for (const raw of targets) {
      const name = raw.trim();
      if (!name) continue;
      try {
        const info = catalog[name];
        if (!info?.url) {
          failed.push({ name, error: "远程目录中不存在" });
          continue;
        }
        await downloadAndWritePlugin(name, info.url, info.desc);
        ok.push(name);
      } catch (e: unknown) {
        failed.push({
          name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (ok.length > 0) {
      try {
        await loadPlugins();
      } catch (e: unknown) {
        logger.error("[panel-tpm] reload after install failed", e);
      }
    }
    return { ok, failed };
  });
}

export async function tpmUninstall(
  names: string[],
): Promise<{ ok: string[]; failed: Array<{ name: string; error: string }> }> {
  return withLock(async () => {
    const ok: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const db = await getDatabase();

    if (names.length === 1 && names[0].toLowerCase() === "all") {
      const local = listLocalPluginFiles();
      for (const name of local) {
        try {
          const fp = path.join(PLUGIN_PATH, `${name}.ts`);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
          delete db.data[name];
          ok.push(name);
        } catch (e: unknown) {
          failed.push({
            name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      await db.write();
      try {
        await loadPlugins();
      } catch (e: unknown) {
        logger.error("[panel-tpm] reload after uninstall-all failed", e);
      }
      return { ok, failed };
    }

    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      try {
        const fp = path.join(PLUGIN_PATH, `${name}.ts`);
        if (!fs.existsSync(fp)) {
          failed.push({ name, error: "本地文件不存在" });
          continue;
        }
        fs.unlinkSync(fp);
        delete db.data[name];
        ok.push(name);
      } catch (e: unknown) {
        failed.push({
          name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await db.write();
    if (ok.length > 0) {
      try {
        await loadPlugins();
      } catch (e: unknown) {
        logger.error("[panel-tpm] reload after uninstall failed", e);
      }
    }
    return { ok, failed };
  });
}

export async function tpmUpdateAll(): Promise<{
  updated: string[];
  unchanged: string[];
  failed: Array<{ name: string; error: string }>;
}> {
  return withLock(async () => {
    const [catalog, db] = await Promise.all([
      getMergedRemotePluginsIndex(),
      getDatabase(),
    ]);
    await rebuildPluginDb(db);
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const names = Object.keys(db.data);
    tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "start", total: names.length });

    for (const name of names) {
      const rec = db.data[name];
      const remote = catalog[name];
      tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "checking", name, total: names.length });
      if (!remote?.url) {
        unchanged.push(name);
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "unchanged", name });
        continue;
      }
      try {
        const pluginUrl = normalizeGithubUrl(remote.url);
        const response = await fetchWithRetry<string>(pluginUrl, {
          responseType: "text",
        });
        if (response.status !== 200 || typeof response.data !== "string") {
          failed.push({ name, error: `HTTP ${response.status}` });
          tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "failed", name, error: `HTTP ${response.status}` });
          continue;
        }
        const filePath = path.join(PLUGIN_PATH, `${name}.ts`);
        const current = fs.existsSync(filePath)
          ? fs.readFileSync(filePath, "utf-8")
          : "";
        if (current === response.data) {
          unchanged.push(name);
          tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "unchanged", name });
          continue;
        }
        if (current) {
          const cacheDir = createDirectoryInTemp("plugin_backups");
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, -5);
          fs.copyFileSync(
            filePath,
            path.join(cacheDir, `${name}_${timestamp}.ts.bak`),
          );
        }
        fs.writeFileSync(filePath, response.data, "utf-8");
        db.data[name] = {
          url: remote.url,
          desc: remote.desc,
          _updatedAt: Date.now(),
        };
        updated.push(name);
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "updated", name });
      } catch (e: unknown) {
        failed.push({
          name,
          error: e instanceof Error ? e.message : String(e),
        });
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "failed", name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await db.write();
    if (updated.length > 0) {
      try {
        await loadPlugins();
      } catch (e: unknown) {
        logger.error("[panel-tpm] reload after update failed", e);
      }
    }
    return { updated, unchanged, failed };
  });
}

export async function tpmGetSource(): Promise<{
  official: string;
  custom: string | null;
}> {
  const custom = await getCustomSourceConfig();
  return { official: PLUGINS_INDEX_URL, custom: custom?.url || null };
}

export async function tpmSetSource(url: string): Promise<void> {
  const raw = url.trim();
  if (!raw) throw new Error("URL 不能为空");
  const indexUrl = convertGithubToRawPluginUrl(raw);
  const res = await fetchWithRetry<RemotePluginsIndex>(indexUrl);
  if (res.status !== 200 || !res.data || typeof res.data !== "object") {
    throw new Error(`无法验证插件源 (HTTP ${res.status})`);
  }
  fs.writeFileSync(
    getCustomSourceConfigPath(),
    JSON.stringify({ url: raw }, null, 2),
    "utf-8",
  );
}

export async function tpmClearSource(): Promise<void> {
  const p = getCustomSourceConfigPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export async function tpmReadPluginSource(
  name: string,
): Promise<{ name: string; content: string; size: number }> {
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, "");
  if (!safe || safe !== name) throw new Error("非法插件名");
  const fp = path.join(PLUGIN_PATH, `${safe}.ts`);
  if (!fs.existsSync(fp)) throw new Error("插件文件不存在");
  const content = fs.readFileSync(fp, "utf-8");
  return { name: safe, content, size: Buffer.byteLength(content) };
}
