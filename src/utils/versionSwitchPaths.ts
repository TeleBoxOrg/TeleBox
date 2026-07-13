/**
 * Path + process helpers for version switch.
 *
 * Never spawn bare "npx"/"tsx" from PATH — PM2 often has a minimal PATH that
 * yields `spawn npx ENOENT`. Always use process.execPath + scripts/run-tsx.cjs.
 *
 * Repo discovery is automatic for non-expert installs:
 *   env override (optional) → path cache → current install → sibling dirs →
 *   home common layouts → PM2 process cwd → auto-clone peer next to current.
 * Users should never need to set TELEBOX_*_ROOT manually.
 */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
  type StdioOptions,
} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { TeleBoxVersion } from "./versionSwitchCore";
import { DEFAULT_SWITCH_HOME } from "./versionSwitchState";

const TELEPROTO_DIR_NAMES = [
  "telebox",
  "TeleBox",
  "Telebox",
  "TELEBOX",
  "telebox-teleproto",
  "TeleBox-teleproto",
];
const MTCUTE_DIR_NAMES = [
  "telebox_mtcute",
  "telebox-mtcute",
  "TeleBox_M",
  "TeleBox_mtcute",
  "TeleBox-mtcute",
  "TeleBox_Mtcute",
  "telebox_m",
  "Telebox_M",
];
const TELEPROTO_PLUGIN_DIR_NAMES = [
  "TeleBox_Plugins",
  "telebox_plugins",
  "TeleBox-Plugins",
  "telebox-plugins",
];
const MTCUTE_PLUGIN_DIR_NAMES = [
  "TeleBox_M_Plugins",
  "telebox_m_plugins",
  "TeleBox_M-Plugins",
  "telebox-m-plugins",
];

const TELEPROTO_CLONE_URL = "https://github.com/TeleBoxOrg/TeleBox.git";
const MTCUTE_CLONE_URL = "https://github.com/TeleBoxOrg/TeleBox_M.git";
const TELEPROTO_PLUGIN_CLONE_URL =
  "https://github.com/TeleBoxOrg/TeleBox_Plugins.git";
const MTCUTE_PLUGIN_CLONE_URL =
  "https://github.com/TeleBoxOrg/TeleBox_M_Plugins.git";

const PATH_CACHE_FILE = path.join(DEFAULT_SWITCH_HOME, "paths.json");

interface PathCache {
  teleproto?: string;
  mtcute?: string;
  teleprotoPlugins?: string;
  mtcutePlugins?: string;
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadPathCache(): PathCache {
  const raw = readJsonSafe(PATH_CACHE_FILE);
  if (!raw) return {};
  const out: PathCache = {};
  for (const key of [
    "teleproto",
    "mtcute",
    "teleprotoPlugins",
    "mtcutePlugins",
  ] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) out[key] = path.resolve(value);
  }
  return out;
}

function savePathCache(patch: PathCache): void {
  try {
    const next = { ...loadPathCache(), ...patch };
    fs.mkdirSync(path.dirname(PATH_CACHE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${PATH_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, PATH_CACHE_FILE);
  } catch (err) {
    console.warn(
      "[versionSwitch] failed to write path cache:",
      err instanceof Error ? err.message : err,
    );
  }
}

function packageDeps(repo: string): Record<string, string> {
  const pkg = readJsonSafe(path.join(repo, "package.json"));
  if (!pkg) return {};
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  const dev = (pkg.devDependencies as Record<string, string> | undefined) ?? {};
  return { ...dev, ...deps };
}

/** Detect edition by package.json deps + switch entry presence. */
export function detectEdition(repo: string): TeleBoxVersion | null {
  if (!fs.existsSync(path.join(repo, "package.json"))) return null;
  if (!fs.existsSync(path.join(repo, "scripts", "run-tsx.cjs"))) return null;
  const deps = packageDeps(repo);
  const hasTeleproto = "teleproto" in deps;
  const hasMtcute = "@mtcute/node" in deps || "@mtcute/core" in deps;
  if (hasTeleproto && !hasMtcute) return "teleproto";
  if (hasMtcute && !hasTeleproto) return "mtcute";
  // Ambiguous: prefer explicit switch plugin location + dep priority
  if (hasMtcute) return "mtcute";
  if (hasTeleproto) return "teleproto";
  return null;
}

function isValidRepo(repo: string, version: TeleBoxVersion): boolean {
  try {
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return false;
  } catch {
    return false;
  }
  return detectEdition(repo) === version;
}

function uniqueDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** Current process install root (PM2 --cwd, npm start, etc.). */
export function findCurrentInstallRoot(): string | null {
  const candidates = [
    process.cwd(),
    // versionSwitchPaths.ts lives in src/utils → repo is ../..
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    if (detectEdition(candidate)) return candidate;
  }
  return null;
}

function listPm2Cwds(): string[] {
  try {
    const out = spawnSync("pm2", ["jlist"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (out.status !== 0 || !out.stdout) return [];
    const list = JSON.parse(out.stdout) as Array<{
      name?: string;
      pm2_env?: { pm_cwd?: string; status?: string };
    }>;
    const dirs: string[] = [];
    for (const proc of list) {
      const cwd = proc.pm2_env?.pm_cwd;
      if (cwd) dirs.push(cwd);
    }
    return dirs;
  } catch {
    return [];
  }
}

function homeSearchRoots(): string[] {
  const home = os.homedir();
  const roots = [
    home,
    path.join(home, "apps"),
    path.join(home, "Projects"),
    path.join(home, "projects"),
    path.join(home, "src"),
    path.join(home, "code"),
    path.join(home, "workspace"),
    path.join(home, "work"),
    path.join(home, "opt"),
    "/opt",
    "/srv",
    "/var/www",
    "/root",
  ];
  const current = findCurrentInstallRoot();
  if (current) {
    roots.unshift(path.dirname(current), current);
  }
  roots.unshift(process.cwd(), path.dirname(process.cwd()));
  return uniqueDirs(roots);
}

function namedCandidates(version: TeleBoxVersion, bases: string[]): string[] {
  const names = version === "teleproto" ? TELEPROTO_DIR_NAMES : MTCUTE_DIR_NAMES;
  const out: string[] = [];
  for (const base of bases) {
    for (const name of names) {
      out.push(path.join(base, name));
    }
  }
  return out;
}

function scanDirectoryChildren(base: string, version: TeleBoxVersion): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(base, entry.name);
    if (isValidRepo(full, version)) return full;
  }
  return null;
}

/**
 * Resolve absolute path to a TeleBox edition checkout.
 * Never requires the user to set env vars; env is only an optional override.
 */
export function resolveRepoRoot(version: TeleBoxVersion): string {
  const envKey =
    version === "teleproto" ? "TELEBOX_TELEPROTO_ROOT" : "TELEBOX_MTCUTE_ROOT";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!isValidRepo(resolved, version)) {
      throw new Error(
        `${envKey}=${fromEnv} 不是有效的 ${version} 仓库（需要 package.json + scripts/run-tsx.cjs + 对应依赖）`,
      );
    }
    savePathCache({ [version]: resolved });
    return resolved;
  }

  const cache = loadPathCache();
  const cached = cache[version];
  if (cached && isValidRepo(cached, version)) return cached;

  // Current install may already be the requested edition
  const current = findCurrentInstallRoot();
  if (current && isValidRepo(current, version)) {
    savePathCache({ [version]: current });
    return current;
  }

  const searchBases = uniqueDirs([
    ...(current ? [path.dirname(current)] : []),
    process.cwd(),
    path.dirname(process.cwd()),
    ...listPm2Cwds().map((d) => path.dirname(d)),
    ...listPm2Cwds(),
    ...homeSearchRoots(),
  ]);

  // 1) Well-known sibling / home names
  for (const candidate of namedCandidates(version, searchBases)) {
    if (isValidRepo(candidate, version)) {
      savePathCache({ [version]: candidate });
      return candidate;
    }
  }

  // 2) PM2 process cwd of either edition
  for (const cwd of listPm2Cwds()) {
    if (isValidRepo(cwd, version)) {
      savePathCache({ [version]: cwd });
      return cwd;
    }
  }

  // 3) Shallow scan of common parent dirs (one level)
  for (const base of searchBases.slice(0, 12)) {
    const hit = scanDirectoryChildren(base, version);
    if (hit) {
      savePathCache({ [version]: hit });
      return hit;
    }
  }

  // 4) Auto-clone peer next to current install (小白 zero-config)
  const cloneParent =
    (current && path.dirname(current)) ||
    path.dirname(process.cwd()) ||
    os.homedir();
  const defaultName = version === "teleproto" ? "telebox" : "telebox_mtcute";
  const cloneTarget = path.join(cloneParent, defaultName);
  if (!fs.existsSync(cloneTarget)) {
    console.log(
      `[versionSwitch] 未找到 ${version} 仓库，正在自动克隆到 ${cloneTarget} …`,
    );
    const url = version === "teleproto" ? TELEPROTO_CLONE_URL : MTCUTE_CLONE_URL;
    const clone = spawnSync(
      "git",
      ["clone", "--depth", "1", url, cloneTarget],
      { stdio: "inherit", timeout: 300_000 },
    );
    if (clone.status !== 0) {
      throw new Error(
        `自动下载 ${version} 失败（git clone ${url}）。请确认本机可访问 GitHub 后重试 .switch go。`,
      );
    }
  }

  if (!isValidRepo(cloneTarget, version) && fs.existsSync(cloneTarget)) {
    // Partial/wrong dir: try detect after npm install
  }

  // npm install so run-tsx + deps exist
  if (fs.existsSync(path.join(cloneTarget, "package.json"))) {
    const nodeModules = path.join(cloneTarget, "node_modules");
    if (!fs.existsSync(nodeModules)) {
      console.log(`[versionSwitch] 正在安装 ${version} 依赖（npm install）…`);
      const install = spawnSync("npm", ["install", "--omit=dev"], {
        cwd: cloneTarget,
        stdio: "inherit",
        timeout: 600_000,
        env: process.env,
      });
      if (install.status !== 0) {
        throw new Error(
          `自动安装 ${version} 依赖失败。请进入 ${cloneTarget} 手动执行 npm install 后重试。`,
        );
      }
    }
  }

  if (!isValidRepo(cloneTarget, version)) {
    throw new Error(
      `无法准备 ${version} 仓库（${cloneTarget}）。请检查 git/npm 是否可用，或把另一版本放在当前安装目录的同级文件夹中。`,
    );
  }

  savePathCache({ [version]: cloneTarget });
  return cloneTarget;
}

export function resolveRepoRoots(): Record<TeleBoxVersion, string> {
  return {
    teleproto: resolveRepoRoot("teleproto"),
    mtcute: resolveRepoRoot("mtcute"),
  };
}

function isPluginIndex(file: string): boolean {
  if (!file.endsWith("plugins.json") || !fs.existsSync(file)) return false;
  const raw = readJsonSafe(file);
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

/** Absolute path to plugins.json for an edition (best-effort; may auto-clone). */
export function resolvePluginIndexPath(version: TeleBoxVersion): string {
  const envKey =
    version === "teleproto"
      ? "TELEBOX_TELEPROTO_PLUGINS"
      : "TELEBOX_MTCUTE_PLUGINS";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!isPluginIndex(resolved)) {
      throw new Error(`${envKey}=${fromEnv} 不是有效的 plugins.json`);
    }
    const cacheKey = version === "teleproto" ? "teleprotoPlugins" : "mtcutePlugins";
    savePathCache({ [cacheKey]: resolved });
    return resolved;
  }

  const cache = loadPathCache();
  const cacheKey = version === "teleproto" ? "teleprotoPlugins" : "mtcutePlugins";
  const cached = cache[cacheKey];
  if (cached && isPluginIndex(cached)) return cached;

  const names =
    version === "teleproto"
      ? TELEPROTO_PLUGIN_DIR_NAMES
      : MTCUTE_PLUGIN_DIR_NAMES;

  let repo: string | null = null;
  try {
    repo = resolveRepoRoot(version);
  } catch {
    repo = findCurrentInstallRoot();
  }

  const bases = uniqueDirs([
    ...(repo ? [path.dirname(repo), repo] : []),
    process.cwd(),
    path.dirname(process.cwd()),
    ...homeSearchRoots(),
  ]);

  const candidates: string[] = [];
  for (const base of bases) {
    for (const name of names) {
      candidates.push(path.join(base, name, "plugins.json"));
    }
  }

  const hit = firstExisting(candidates.filter((c) => isPluginIndex(c)));
  if (hit) {
    savePathCache({ [cacheKey]: hit });
    return hit;
  }

  // Auto-clone plugin index repo next to main install
  const parent =
    (repo && path.dirname(repo)) || path.dirname(process.cwd()) || os.homedir();
  const defaultName =
    version === "teleproto" ? "TeleBox_Plugins" : "TeleBox_M_Plugins";
  const cloneTarget = path.join(parent, defaultName);
  if (!fs.existsSync(cloneTarget)) {
    console.log(
      `[versionSwitch] 未找到 ${version} 插件仓库，正在自动克隆到 ${cloneTarget} …`,
    );
    const url =
      version === "teleproto"
        ? TELEPROTO_PLUGIN_CLONE_URL
        : MTCUTE_PLUGIN_CLONE_URL;
    const clone = spawnSync(
      "git",
      ["clone", "--depth", "1", url, cloneTarget],
      { stdio: "inherit", timeout: 300_000 },
    );
    if (clone.status !== 0) {
      throw new Error(
        `自动下载 ${version} 插件索引失败。请确认本机可访问 GitHub 后重试。`,
      );
    }
  }

  const index = path.join(cloneTarget, "plugins.json");
  if (!isPluginIndex(index)) {
    throw new Error(`插件索引无效: ${index}`);
  }
  savePathCache({ [cacheKey]: index });
  return index;
}

function runTsxCli(repoRoot: string): string {
  const cli = path.join(repoRoot, "scripts", "run-tsx.cjs");
  if (!fs.existsSync(cli)) {
    throw new Error(
      `缺少 ${cli}，无法启动 TypeScript 脚本（不要依赖 PATH 中的 npx）`,
    );
  }
  return cli;
}

function resolveScriptPath(repoRoot: string, script: string): string {
  return path.isAbsolute(script) ? script : path.join(repoRoot, script);
}

export interface SpawnTsxOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  timeout?: number;
  detached?: boolean;
}

/**
 * Synchronous: node scripts/run-tsx.cjs <script.ts>
 * Uses process.execPath so Node is always found even when PATH is empty.
 */
export function spawnTsxSync(
  repoRoot: string,
  script: string,
  options: SpawnTsxOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const cli = runTsxCli(repoRoot);
  const scriptPath = resolveScriptPath(repoRoot, script);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`脚本不存在: ${scriptPath}`);
  }
  return spawnSync(process.execPath, [cli, scriptPath], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    timeout: options.timeout,
  });
}

/**
 * Detached async spawn for fire-and-forget controller processes.
 * Attaches an error listener so ENOENT never becomes an uncaughtException.
 */
export function spawnTsxDetached(
  repoRoot: string,
  script: string,
  options: SpawnTsxOptions = {},
): ChildProcess {
  const cli = runTsxCli(repoRoot);
  const scriptPath = resolveScriptPath(repoRoot, script);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`脚本不存在: ${scriptPath}`);
  }
  const child = spawn(
    process.execPath,
    [cli, scriptPath],
    {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "ignore",
      detached: options.detached ?? true,
    },
  );
  child.on("error", (err: Error) => {
    console.error(
      `[versionSwitch] failed to spawn ${scriptPath} via ${cli}:`,
      err.message,
    );
  });
  return child;
}
