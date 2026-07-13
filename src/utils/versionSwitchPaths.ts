/**
 * Path + process helpers for version switch.
 *
 * Layout (after first .switch go):
 *   <runtimeHome>/                 e.g. ~/telebox  (original install path)
 *     telebox-teleproto/           teleproto edition
 *     telebox-mtcute/              mtcute edition
 *
 * Flat installs (code at runtimeHome root) are restructured on first switch:
 * current edition moves into telebox-teleproto|telebox-mtcute; peer is cloned
 * as the sibling. PM2 --cwd always points at the edition subdir, not home.
 *
 * Never spawn bare "npx"/"tsx" from PATH — use process.execPath + run-tsx.cjs.
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

/** Canonical edition folder names under runtime home. */
export const PEER_DIR_NAME: Record<TeleBoxVersion, string> = {
  teleproto: "telebox-teleproto",
  mtcute: "telebox-mtcute",
};

const TELEPROTO_CLONE_URL = "https://github.com/TeleBoxOrg/TeleBox.git";
const MTCUTE_CLONE_URL = "https://github.com/TeleBoxOrg/TeleBox_M.git";
const TELEPROTO_PLUGIN_CLONE_URL =
  "https://github.com/TeleBoxOrg/TeleBox_Plugins.git";
const MTCUTE_PLUGIN_CLONE_URL =
  "https://github.com/TeleBoxOrg/TeleBox_M_Plugins.git";

const PATH_CACHE_FILE = path.join(DEFAULT_SWITCH_HOME, "paths.json");

/** Names that must stay at runtime home during flat→nested move. */
const HOME_RESERVED = new Set([
  PEER_DIR_NAME.teleproto,
  PEER_DIR_NAME.mtcute,
  "TeleBox_Plugins",
  "TeleBox_M_Plugins",
  "telebox_plugins",
  "telebox_m_plugins",
]);

interface PathCache {
  runtimeHome?: string;
  teleproto?: string;
  mtcute?: string;
  teleprotoPlugins?: string;
  mtcutePlugins?: string;
  /** Flat install still needs move into PEER_DIR_NAME after PM2 stop. */
  pendingNest?: {
    version: TeleBoxVersion;
    from: string;
  } | null;
}

export interface NestedLayout {
  home: string;
  roots: Record<TeleBoxVersion, string>;
  /** Call after source PM2 is stopped if set. */
  pendingNest: PathCache["pendingNest"] | null;
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
    "runtimeHome",
    "teleproto",
    "mtcute",
    "teleprotoPlugins",
    "mtcutePlugins",
  ] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      out[key] = path.resolve(value);
    }
  }
  const pending = raw.pendingNest;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    const p = pending as Record<string, unknown>;
    if (
      (p.version === "teleproto" || p.version === "mtcute") &&
      typeof p.from === "string"
    ) {
      out.pendingNest = {
        version: p.version,
        from: path.resolve(p.from),
      };
    }
  }
  return out;
}

function savePathCache(patch: Partial<PathCache> & { pendingNest?: PathCache["pendingNest"] | null }): void {
  try {
    const prev = loadPathCache();
    const next: PathCache = { ...prev };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "pendingNest" && v === null) {
        delete next.pendingNest;
      } else if (v !== undefined && v !== null) {
        (next as Record<string, unknown>)[k] = v;
      }
    }
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

/** Detect edition by package.json deps + run-tsx. */
export function detectEdition(repo: string): TeleBoxVersion | null {
  if (!fs.existsSync(path.join(repo, "package.json"))) return null;
  if (!fs.existsSync(path.join(repo, "scripts", "run-tsx.cjs"))) return null;
  const deps = packageDeps(repo);
  const hasTeleproto = "teleproto" in deps;
  const hasMtcute = "@mtcute/node" in deps || "@mtcute/core" in deps;
  if (hasTeleproto && !hasMtcute) return "teleproto";
  if (hasMtcute && !hasTeleproto) return "mtcute";
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
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    if (detectEdition(candidate)) return path.resolve(candidate);
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
      pm2_env?: { pm_cwd?: string };
    }>;
    return list
      .map((p) => p.pm2_env?.pm_cwd)
      .filter((d): d is string => Boolean(d));
  } catch {
    return [];
  }
}

/**
 * Runtime home = original user install directory that owns both editions.
 * Example: ~/telebox containing telebox-teleproto + telebox-mtcute.
 */
export function resolveRuntimeHome(): string {
  const cache = loadPathCache();
  if (cache.runtimeHome && fs.existsSync(cache.runtimeHome)) {
    return cache.runtimeHome;
  }

  const current = findCurrentInstallRoot();
  if (current) {
    const base = path.basename(current);
    if (base === PEER_DIR_NAME.teleproto || base === PEER_DIR_NAME.mtcute) {
      const home = path.dirname(current);
      savePathCache({ runtimeHome: home });
      return home;
    }
    // Flat install: home IS the current root
    savePathCache({ runtimeHome: current });
    return current;
  }

  for (const cwd of listPm2Cwds()) {
    const edition = detectEdition(cwd);
    if (!edition) continue;
    const base = path.basename(cwd);
    if (base === PEER_DIR_NAME.teleproto || base === PEER_DIR_NAME.mtcute) {
      const home = path.dirname(cwd);
      savePathCache({ runtimeHome: home });
      return home;
    }
    savePathCache({ runtimeHome: cwd });
    return cwd;
  }

  throw new Error("无法定位 TeleBox 运行时目录（runtime home）");
}

function cloneEdition(version: TeleBoxVersion, targetDir: string): void {
  const url = version === "teleproto" ? TELEPROTO_CLONE_URL : MTCUTE_CLONE_URL;
  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir);
    if (entries.length === 0) fs.rmdirSync(targetDir);
    else if (!fs.existsSync(path.join(targetDir, "package.json"))) {
      throw new Error(
        `目录已存在但不是有效仓库: ${targetDir}\n请删除后重试 .switch go`,
      );
    } else {
      return; // already has package.json — install deps below
    }
  }
  console.log(`[versionSwitch] 克隆 ${version} → ${targetDir}`);
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", url, targetDir],
    { stdio: "inherit", timeout: 300_000 },
  );
  if (clone.status !== 0) {
    throw new Error(
      `git clone ${version} 失败。请确认可访问 GitHub 后重试。\n${targetDir}`,
    );
  }
}

function ensureNpmInstall(repo: string, label: string): void {
  const pkg = path.join(repo, "package.json");
  const nodeModules = path.join(repo, "node_modules");
  if (!fs.existsSync(pkg) || fs.existsSync(nodeModules)) return;
  console.log(`[versionSwitch] npm install (${label})…`);
  const install = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: repo,
    stdio: "inherit",
    timeout: 600_000,
    env: process.env,
  });
  if (install.status !== 0) {
    throw new Error(`npm install 失败: ${repo}`);
  }
}

/**
 * Move flat runtime home contents into home/telebox-xx.
 * Must run only when no process is using the flat root as cwd (after pm2 stop).
 */
export function completePendingNest(
  pending: NonNullable<PathCache["pendingNest"]>,
  home: string,
): string {
  const dest = path.join(home, PEER_DIR_NAME[pending.version]);
  if (isValidRepo(dest, pending.version)) {
    savePathCache({
      [pending.version]: dest,
      pendingNest: null,
    });
    return dest;
  }

  console.log(
    `[versionSwitch] 整理目录：把当前 ${pending.version} 移入 ${PEER_DIR_NAME[pending.version]}`,
  );
  fs.mkdirSync(dest, { recursive: true });

  const from = path.resolve(pending.from);
  if (path.resolve(from) !== path.resolve(home)) {
    // Unexpected — copy/move from explicit path if different
    if (isValidRepo(from, pending.version) && from !== dest) {
      // rare: already elsewhere
      savePathCache({ [pending.version]: from, pendingNest: null });
      return from;
    }
  }

  const entries = fs.readdirSync(home);
  for (const name of entries) {
    if (HOME_RESERVED.has(name)) continue;
    if (name === PEER_DIR_NAME[pending.version]) continue;
    const srcPath = path.join(home, name);
    const destPath = path.join(dest, name);
    if (fs.existsSync(destPath)) {
      // already moved partially
      continue;
    }
    fs.renameSync(srcPath, destPath);
  }

  if (!isValidRepo(dest, pending.version)) {
    throw new Error(
      `整理目录失败，${dest} 不是有效的 ${pending.version} 仓库`,
    );
  }

  savePathCache({
    runtimeHome: home,
    [pending.version]: dest,
    pendingNest: null,
  });
  console.log(`[versionSwitch] ${pending.version} → ${dest}`);
  return dest;
}

/**
 * Ensure dual-edition nested layout under original runtime home.
 * Does NOT move a live flat install until completePendingNest (after pm2 stop).
 */
export function ensureNestedLayout(): NestedLayout {
  const home = resolveRuntimeHome();
  const cache = loadPathCache();
  let pendingNest: PathCache["pendingNest"] | null = cache.pendingNest ?? null;

  const nestedTele = path.join(home, PEER_DIR_NAME.teleproto);
  const nestedMtcute = path.join(home, PEER_DIR_NAME.mtcute);

  const homeEdition = detectEdition(home);
  const teleReady = isValidRepo(nestedTele, "teleproto");
  const mtcuteReady = isValidRepo(nestedMtcute, "mtcute");

  // Flat install still at home root
  if (homeEdition && !teleReady && !mtcuteReady) {
    pendingNest = { version: homeEdition, from: home };
    savePathCache({
      runtimeHome: home,
      pendingNest,
      // temporary: use flat home as this edition until nest completes
      [homeEdition]: home,
    });
  } else if (homeEdition && homeEdition === "teleproto" && !teleReady) {
    pendingNest = { version: "teleproto", from: home };
    savePathCache({ runtimeHome: home, pendingNest, teleproto: home });
  } else if (homeEdition && homeEdition === "mtcute" && !mtcuteReady) {
    pendingNest = { version: "mtcute", from: home };
    savePathCache({ runtimeHome: home, pendingNest, mtcute: home });
  }

  // Ensure both edition dirs exist (peer clone into home/telebox-xx)
  for (const version of ["teleproto", "mtcute"] as const) {
    const dest = path.join(home, PEER_DIR_NAME[version]);
    const isPendingFlat =
      pendingNest?.version === version &&
      path.resolve(pendingNest.from) === path.resolve(home);

    if (isPendingFlat) {
      // still flat at home — don't clone over it
      continue;
    }

    if (isValidRepo(dest, version)) {
      savePathCache({ [version]: dest, runtimeHome: home });
      continue;
    }

    // Cached path elsewhere?
    const cached = loadPathCache()[version];
    if (cached && isValidRepo(cached, version) && cached !== dest) {
      // Prefer nested under home: if dest empty/missing, we could leave external
      // but user asked for everything under runtime home — clone into dest
    }

    if (!fs.existsSync(dest) || fs.readdirSync(dest).length === 0) {
      console.log(
        `[versionSwitch] 在运行时目录下准备 ${PEER_DIR_NAME[version]}`,
      );
      cloneEdition(version, dest);
      ensureNpmInstall(dest, PEER_DIR_NAME[version]);
    } else if (fs.existsSync(path.join(dest, "package.json"))) {
      ensureNpmInstall(dest, PEER_DIR_NAME[version]);
    }

    if (isValidRepo(dest, version)) {
      savePathCache({ [version]: dest, runtimeHome: home });
    }
  }

  // Resolve roots for this moment (flat source may still be `home`)
  const roots: Record<TeleBoxVersion, string> = {
    teleproto: isValidRepo(nestedTele, "teleproto")
      ? nestedTele
      : homeEdition === "teleproto"
        ? home
        : isValidRepo(nestedTele, "teleproto")
          ? nestedTele
          : nestedTele,
    mtcute: isValidRepo(nestedMtcute, "mtcute")
      ? nestedMtcute
      : homeEdition === "mtcute"
        ? home
        : nestedMtcute,
  };

  // Fix roots from cache if valid
  const latest = loadPathCache();
  if (latest.teleproto && isValidRepo(latest.teleproto, "teleproto")) {
    roots.teleproto = latest.teleproto;
  }
  if (latest.mtcute && isValidRepo(latest.mtcute, "mtcute")) {
    roots.mtcute = latest.mtcute;
  }

  // Validate peer exists for switch target
  for (const version of ["teleproto", "mtcute"] as const) {
    if (!isValidRepo(roots[version], version)) {
      // try force prepare nested (non-pending)
      if (!(pendingNest?.version === version && roots[version] === home)) {
        const dest = path.join(home, PEER_DIR_NAME[version]);
        cloneEdition(version, dest);
        ensureNpmInstall(dest, PEER_DIR_NAME[version]);
        if (isValidRepo(dest, version)) {
          roots[version] = dest;
          savePathCache({ [version]: dest, runtimeHome: home });
        }
      }
    }
  }

  savePathCache({
    runtimeHome: home,
    teleproto: roots.teleproto,
    mtcute: roots.mtcute,
    ...(pendingNest ? { pendingNest } : {}),
  });

  return { home, roots, pendingNest };
}

/**
 * Resolve absolute path to a TeleBox edition checkout under runtime home.
 */
export function resolveRepoRoot(version: TeleBoxVersion): string {
  const envKey =
    version === "teleproto" ? "TELEBOX_TELEPROTO_ROOT" : "TELEBOX_MTCUTE_ROOT";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!isValidRepo(resolved, version)) {
      throw new Error(`${envKey}=${fromEnv} 不是有效的 ${version} 仓库`);
    }
    savePathCache({ [version]: resolved });
    return resolved;
  }

  const layout = ensureNestedLayout();
  const root = layout.roots[version];
  if (!isValidRepo(root, version)) {
    throw new Error(
      `无法准备 ${version}（期望 ${path.join(layout.home, PEER_DIR_NAME[version])}）`,
    );
  }
  return root;
}

export function resolveRepoRoots(): Record<TeleBoxVersion, string> {
  return ensureNestedLayout().roots;
}

function isPluginIndex(file: string): boolean {
  if (!file.endsWith("plugins.json") || !fs.existsSync(file)) return false;
  const raw = readJsonSafe(file);
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

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
    const cacheKey =
      version === "teleproto" ? "teleprotoPlugins" : "mtcutePlugins";
    savePathCache({ [cacheKey]: resolved });
    return resolved;
  }

  const cache = loadPathCache();
  const cacheKey =
    version === "teleproto" ? "teleprotoPlugins" : "mtcutePlugins";
  if (cache[cacheKey] && isPluginIndex(cache[cacheKey]!)) {
    return cache[cacheKey]!;
  }

  let home: string;
  try {
    home = resolveRuntimeHome();
  } catch {
    home = os.homedir();
  }

  const names =
    version === "teleproto"
      ? ["TeleBox_Plugins", "telebox_plugins"]
      : ["TeleBox_M_Plugins", "telebox_m_plugins"];

  const candidates = [
    ...names.map((n) => path.join(home, n, "plugins.json")),
    ...names.map((n) => path.join(path.dirname(home), n, "plugins.json")),
  ];
  for (const candidate of candidates) {
    if (isPluginIndex(candidate)) {
      savePathCache({ [cacheKey]: candidate });
      return candidate;
    }
  }

  const defaultName =
    version === "teleproto" ? "TeleBox_Plugins" : "TeleBox_M_Plugins";
  const cloneTarget = path.join(home, defaultName);
  if (!fs.existsSync(cloneTarget)) {
    console.log(`[versionSwitch] 克隆插件索引 → ${cloneTarget}`);
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
      throw new Error(`自动下载插件索引失败: ${url}`);
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
    throw new Error(`缺少 ${cli}（不要依赖 PATH 中的 npx）`);
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
  const child = spawn(process.execPath, [cli, scriptPath], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "ignore",
    detached: options.detached ?? true,
  });
  child.on("error", (err: Error) => {
    console.error(
      `[versionSwitch] failed to spawn ${scriptPath} via ${cli}:`,
      err.message,
    );
  });
  return child;
}

/**
 * PM2 process names. Active bot uses edition-specific name so both can exist
 * with correct --cwd under the nested layout.
 */
export const PM2_PROCESS_NAMES: Record<TeleBoxVersion, string> = {
  teleproto: "telebox",
  mtcute: "telebox-mtcute",
};

/**
 * Start (or recreate) PM2 process for an edition with --cwd = edition root.
 */
export function pm2StartEdition(
  version: TeleBoxVersion,
  repoRoot: string,
  runPm2: (args: string[], label: string) => void,
  getPm2Process: (name: string) => unknown,
): void {
  const name = PM2_PROCESS_NAMES[version];
  if (!isValidRepo(repoRoot, version)) {
    throw new Error(`PM2 start: 无效仓库 ${repoRoot} (${version})`);
  }
  if (getPm2Process(name)) {
    runPm2(["delete", name], `delete stale ${name}`);
  }
  // Also drop mis-pointed "telebox" if starting mtcute from old flat cwd, etc.
  const command = "exec node scripts/run-tsx.cjs ./src/index.ts";
  runPm2(
    [
      "start",
      "bash",
      "--name",
      name,
      "--cwd",
      repoRoot,
      "--time",
      "--max-memory-restart",
      "512M",
      "--restart-delay",
      "5000",
      "--",
      "-lc",
      command,
    ],
    `start ${name} cwd=${repoRoot}`,
  );
}
