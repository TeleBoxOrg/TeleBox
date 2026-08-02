/**
 * Path + process helpers for version switch.
 *
 * Default layout (flat / sibling dirs):
 *   /root/telebox          TeleBox (teleproto)
 *   /root/telebox-next     TeleBox-Next (mtcute)
 *
 * Legacy nested layout (still supported):
 *   <runtimeHome>/         e.g. ~/telebox
 *     telebox-classic/     TeleBox (teleproto)
 *     telebox-next/        TeleBox-Next (mtcute)
 *
 * Flat installs are the default — no restructuring needed. If a user has an
 * old nested layout, it is detected and used as-is. PM2 --cwd always points
 * at the edition root, whether flat or nested.
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
  teleproto: "telebox-classic",
  mtcute: "telebox-next",
};

/** Legacy folder names still accepted when resolving existing installs. */
const LEGACY_PEER_DIR_NAMES: Record<TeleBoxVersion, string[]> = {
  teleproto: ["telebox-teleproto", "telebox-classic"],
  mtcute: ["telebox-mtcute", "telebox_mtcute", "TeleBox_M", "telebox-next"],
};

/** Canonical flat directory names for each edition (sibling dirs, not under a runtime home). */
const FLAT_DIR_NAMES: Record<TeleBoxVersion, string[]> = {
  teleproto: ["telebox", "telebox-classic"],
  mtcute: ["telebox-next", "telebox_mtcute"],
};

/** Check if a directory name is a flat install name for an edition. */
function isFlatDirName(base: string, version: TeleBoxVersion): boolean {
  return FLAT_DIR_NAMES[version].includes(base);
}

/** Find a flat (sibling) peer edition by scanning parent directory. */
function findFlatPeerEdition(currentRepo: string, peerVersion: TeleBoxVersion): string | null {
  const parent = path.dirname(currentRepo);
  const currentBase = path.basename(currentRepo);
  for (const name of FLAT_DIR_NAMES[peerVersion]) {
    if (name === currentBase) continue; // can't be own peer
    const candidate = path.join(parent, name);
    if (isValidRepo(candidate, peerVersion)) return candidate;
  }
  return null;
}

function isEditionSubdirName(base: string): boolean {
  return (
    base === PEER_DIR_NAME.teleproto ||
    base === PEER_DIR_NAME.mtcute ||
    LEGACY_PEER_DIR_NAMES.teleproto.includes(base) ||
    LEGACY_PEER_DIR_NAMES.mtcute.includes(base)
  );
}

function nestedCandidates(home: string, version: TeleBoxVersion): string[] {
  const names = [
    PEER_DIR_NAME[version],
    ...LEGACY_PEER_DIR_NAMES[version],
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(path.join(home, name));
  }
  return out;
}

function findNestedEdition(home: string, version: TeleBoxVersion): string | null {
  for (const candidate of nestedCandidates(home, version)) {
    if (isValidRepo(candidate, version)) return candidate;
  }
  return null;
}

const TELEPROTO_CLONE_URL = "https://github.com/TeleBoxOrg/TeleBox.git";
const MTCUTE_CLONE_URL = "https://github.com/TeleBoxOrg/TeleBox-Next.git";

const PATH_CACHE_FILE = path.join(DEFAULT_SWITCH_HOME, "paths.json");
const PLUGIN_REPOS_DIR = path.join(DEFAULT_SWITCH_HOME, "plugin-repos");

/** Names that must stay at runtime home during flat→nested move. */
const HOME_RESERVED = new Set([
  PEER_DIR_NAME.teleproto,
  PEER_DIR_NAME.mtcute,
]);

interface PathCache {
  runtimeHome?: string;
  teleproto?: string;
  mtcute?: string;
  teleprotoPlugins?: string;
  mtcutePlugins?: string;
  /** Nested layout: flat install still needs move into PEER_DIR_NAME after PM2 stop. */
  pendingNest?: {
    version: TeleBoxVersion;
    from: string;
  } | null;
}

export interface EditionLayout {
  home: string;
  roots: Record<TeleBoxVersion, string>;
  /** Call after source PM2 is stopped if set (nested layout only). */
  pendingNest: PathCache["pendingNest"] | null;
  /** true = sibling dirs (flat), false = nested under home. */
  flat: boolean;
}

/** Backward-compat alias. */
export type NestedLayout = EditionLayout;

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

/** True when node_modules has real packages (not a placeholder .gitkeep). */
export function hasUsableNodeModules(repo: string): boolean {
  const nm = path.join(repo, "node_modules");
  if (!fs.existsSync(nm)) return false;
  try {
    const entries = fs.readdirSync(nm).filter(
      (e) => e !== ".gitkeep" && e !== ".package-lock.json" && !e.startsWith("."),
    );
    // Need at least one real package dir
    return entries.some((e) => {
      try {
        return fs.statSync(path.join(nm, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Repo is cloned AND dependencies installed — safe to run. */
export function isRunnableRepo(repo: string, version: TeleBoxVersion): boolean {
  return isValidRepo(repo, version) && hasUsableNodeModules(repo);
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
 * Runtime home = directory that owns both editions.
 * - Nested: ~/telebox containing telebox-classic + telebox-next
 * - Flat:   /root containing telebox + telebox-next (home = parent)
 */
export function resolveRuntimeHome(): string {
  const cache = loadPathCache();
  if (cache.runtimeHome && fs.existsSync(cache.runtimeHome)) {
    // Validate cached home: check if it has nested edition subdirs or flat siblings
    const nestedTele = findNestedEdition(cache.runtimeHome, "teleproto");
    const nestedMtcute = findNestedEdition(cache.runtimeHome, "mtcute");
    if (nestedTele || nestedMtcute) {
      // Nested layout confirmed — cached home is correct
      return cache.runtimeHome;
    }
    // Check if home itself is a flat edition (old cache pointed at flat root)
    const homeEdition = detectEdition(cache.runtimeHome);
    if (homeEdition) {
      const base = path.basename(cache.runtimeHome);
      if (isFlatDirName(base, homeEdition)) {
        // Flat install — home should be parent, not the repo itself
        const parent = path.dirname(cache.runtimeHome);
        savePathCache({ runtimeHome: parent });
        return parent;
      }
      // Not a recognized flat name — keep as-is (could be a custom dir)
      return cache.runtimeHome;
    }
    // Cached home has no editions — check if cached edition paths are valid flat siblings
    if (cache.teleproto && isValidRepo(cache.teleproto, "teleproto") &&
        cache.mtcute && isValidRepo(cache.mtcute, "mtcute")) {
      // Both cached paths are valid — keep cached home if both paths are under it
      // or if they're siblings under the parent
      return cache.runtimeHome;
    }
    // Cache is stale — fall through to detection
  }

  const current = findCurrentInstallRoot();
  if (current) {
    const base = path.basename(current);
    if (isEditionSubdirName(base)) {
      // Nested layout: home is parent
      const home = path.dirname(current);
      savePathCache({ runtimeHome: home });
      return home;
    }
    // Flat install: home is parent (so both siblings are under it)
    const home = path.dirname(current);
    savePathCache({ runtimeHome: home });
    return home;
  }

  for (const cwd of listPm2Cwds()) {
    const edition = detectEdition(cwd);
    if (!edition) continue;
    const base = path.basename(cwd);
    if (isEditionSubdirName(base)) {
      const home = path.dirname(cwd);
      savePathCache({ runtimeHome: home });
      return home;
    }
    // Flat install: home is parent
    const home = path.dirname(cwd);
    savePathCache({ runtimeHome: home });
    return home;
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
  if (!fs.existsSync(pkg)) {
    throw new Error(`缺少 package.json: ${repo}`);
  }
  const nodeModules = path.join(repo, "node_modules");
  // Placeholder node_modules (e.g. only .gitkeep) blocks install — remove it
  if (fs.existsSync(nodeModules) && !hasUsableNodeModules(repo)) {
    console.log(`[versionSwitch] 清理无效 node_modules (${label})`);
    fs.rmSync(nodeModules, { recursive: true, force: true });
  }
  if (hasUsableNodeModules(repo)) return;
  console.log(`[versionSwitch] npm install (${label})…`);
  
  // Respect mise/node version manager by using project's node via npm exec / npx from repo
  const nodeBin = process.execPath;
  const npmCli = path.join(path.dirname(nodeBin), "npm");
  const install = spawnSync(npmCli, ["install"], {
    cwd: repo,
    stdio: "inherit",
    timeout: 600_000,
    env: {
      ...process.env,
      // Ensure npm uses the same node version as the controller
      NODE: nodeBin,
    },
  });
  if (install.status !== 0) {
    throw new Error(`npm install 失败: ${repo}`);
  }
  
  // npm 11+ require approve-scripts for native build packages
  console.log(`[versionSwitch] npm approve-scripts (${label})…`);
  const approve = spawnSync(npmCli, ["approve-scripts", "--allow-scripts-pending"], {
    cwd: repo,
    stdio: "inherit",
    timeout: 60_000,
    env: {
      ...process.env,
      NODE: nodeBin,
    },
  });
  if (approve.status !== 0) {
    console.warn(`[versionSwitch] npm approve-scripts 返回非零码 (${approve.status}): ${repo} — 继续尝试`);
  }
  
  if (!hasUsableNodeModules(repo)) {
    throw new Error(`npm install 后仍无可用依赖: ${repo}`);
  }
}

/**
 * Move flat runtime home contents into home/telebox-xx (nested layout only).
 * Must run only when no process is using the flat root as cwd (after pm2 stop).
 * For flat layout, this is never called (pendingNest is null).
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
 * Ensure dual-edition layout (flat or nested) under runtime home.
 *
 * Flat layout (default): editions are sibling directories under home.
 *   e.g. /root/telebox + /root/telebox-next (home = /root)
 * No pendingNest is set for flat — no restructuring needed.
 *
 * Nested layout (legacy): editions are subdirs under home.
 *   e.g. ~/telebox/telebox-classic + ~/telebox/telebox-next
 * If the current install is still flat at home root, pendingNest is set
 * and completePendingNest() moves it into a subdir after PM2 stop.
 */
export function ensureNestedLayout(
  options: { prepareMissing?: boolean } = {},
): EditionLayout {
  const prepareMissing = options.prepareMissing === true;
  const home = resolveRuntimeHome();
  const cache = loadPathCache();
  let pendingNest: PathCache["pendingNest"] | null = cache.pendingNest ?? null;

  // ── Detect layout: flat (sibling dirs) vs nested (subdirs under home) ──

  // Check for nested editions under home
  const nestedTele =
    findNestedEdition(home, "teleproto") ??
    path.join(home, PEER_DIR_NAME.teleproto);
  const nestedMtcute =
    findNestedEdition(home, "mtcute") ?? path.join(home, PEER_DIR_NAME.mtcute);

  const teleReady = isValidRepo(nestedTele, "teleproto");
  const mtcuteReady = isValidRepo(nestedMtcute, "mtcute");

  // Check for flat editions: home itself could be a flat edition root,
  // or editions could be sibling dirs under home.
  const homeEdition = detectEdition(home);

  // Find flat peer editions by scanning home dir for sibling repos
  const flatTele = findFlatPeerEdition(path.join(home, "__probe__"), "teleproto");
  const flatMtcute = findFlatPeerEdition(path.join(home, "__probe__"), "mtcute");
  // Also check if home itself is a flat edition
  const flatHomeTele = homeEdition === "teleproto" ? home : null;
  const flatHomeMtcute = homeEdition === "mtcute" ? home : null;

  // Determine the actual flat paths for each edition
  const flatTeleRoot = flatTele ?? flatHomeTele;
  const flatMtcuteRoot = flatMtcute ?? flatHomeMtcute;

  // Is this a flat layout? (at least one edition found as a flat sibling/home)
  const isFlat =
    Boolean(flatTeleRoot || flatMtcuteRoot) &&
    !(teleReady || mtcuteReady); // not nested

  // ── Flat layout: no nesting needed ──
  if (isFlat) {
    // Determine roots: flat paths for found editions, sibling paths for missing
    const roots: Record<TeleBoxVersion, string> = {
      teleproto: flatTeleRoot ?? path.join(home, FLAT_DIR_NAMES.teleproto[0]),
      mtcute: flatMtcuteRoot ?? path.join(home, FLAT_DIR_NAMES.mtcute[0]),
    };

    // Fix roots from cache if valid
    const latest = loadPathCache();
    if (latest.teleproto && isValidRepo(latest.teleproto, "teleproto")) {
      roots.teleproto = latest.teleproto;
    }
    if (latest.mtcute && isValidRepo(latest.mtcute, "mtcute")) {
      roots.mtcute = latest.mtcute;
    }

    // Clear any stale pendingNest from a previous nested attempt
    if (pendingNest) {
      pendingNest = null;
      savePathCache({ pendingNest: null });
    }

    savePathCache({
      runtimeHome: home,
      teleproto: roots.teleproto,
      mtcute: roots.mtcute,
    });

    // Prepare missing editions as flat siblings if requested
    if (prepareMissing) {
      for (const version of ["teleproto", "mtcute"] as const) {
        if (isValidRepo(roots[version], version)) continue;
        const flatDest = path.join(home, FLAT_DIR_NAMES[version][0]);
        if (isValidRepo(flatDest, version)) {
          roots[version] = flatDest;
          savePathCache({ [version]: flatDest, runtimeHome: home });
          continue;
        }
        if (!fs.existsSync(flatDest) || fs.readdirSync(flatDest).length === 0) {
          console.log(
            `[versionSwitch] 准备 ${FLAT_DIR_NAMES[version][0]} → ${flatDest}`,
          );
          cloneEdition(version, flatDest);
          ensureNpmInstall(flatDest, FLAT_DIR_NAMES[version][0]);
        } else if (fs.existsSync(path.join(flatDest, "package.json"))) {
          ensureNpmInstall(flatDest, FLAT_DIR_NAMES[version][0]);
        }
        if (isValidRepo(flatDest, version)) {
          roots[version] = flatDest;
          savePathCache({ [version]: flatDest, runtimeHome: home });
        }
      }
    }

    return { home, roots, pendingNest: null, flat: true };
  }

  // ── Nested layout (legacy) ──
  // Flat install still at home root — needs nesting after PM2 stop
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

    if (!prepareMissing) {
      // Plugin path: never block the bot on git clone / npm install
      if (isValidRepo(dest, version)) {
        savePathCache({ [version]: dest, runtimeHome: home });
      }
      continue;
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

  return { home, roots, pendingNest, flat: false };
}

/**
 * Resolve absolute path to a TeleBox edition checkout under runtime home.
 */
export function resolveRepoRoot(
  version: TeleBoxVersion,
  options: { prepare?: boolean } = {},
): string {
  const envKey =
    version === "teleproto" ? "TELEBOX_TELEPROTO_ROOT" : "TELEBOX_MTCUTE_ROOT";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!isValidRepo(resolved, version)) {
      throw new Error(`${envKey}=${fromEnv} 不是有效的 ${version} 仓库`);
    }
    if (options.prepare) ensureNpmInstall(resolved, path.basename(resolved));
    savePathCache({ [version]: resolved });
    return resolved;
  }

  if (options.prepare) {
    return prepareEdition(version);
  }

  const layout = ensureNestedLayout({ prepareMissing: false });
  const root = layout.roots[version];
  // Source edition is usually the flat sibling or nested — must already exist
  if (isValidRepo(root, version)) return root;
  // Target may not exist yet — return expected path (controller prepares)
  if (layout.flat) {
    return path.join(layout.home, FLAT_DIR_NAMES[version][0]);
  }
  return path.join(layout.home, PEER_DIR_NAME[version]);
}

/**
 * Clone (if needed) + npm install edition.
 * For flat layout: clones as sibling directory (e.g. /root/telebox-next).
 * For nested layout: clones under home/telebox-xx.
 * Safe to call from controller with progress; never from the live bot hot path.
 */
export function prepareEdition(version: TeleBoxVersion): string {
  const home = resolveRuntimeHome();
  const cache = loadPathCache();
  const pending = cache.pendingNest;

  // Determine layout to choose clone target
  const layout = ensureNestedLayout({ prepareMissing: false });
  const isFlat = layout.flat;

  // For flat layout, dest is a sibling directory
  const dest = isFlat
    ? path.join(home, FLAT_DIR_NAMES[version][0])
    : path.join(home, PEER_DIR_NAME[version]);
  const destLabel = isFlat ? FLAT_DIR_NAMES[version][0] : PEER_DIR_NAME[version];

  const isPendingFlat =
    !isFlat &&
    pending?.version === version &&
    path.resolve(pending.from) === path.resolve(home);

  if (isPendingFlat) {
    // Still flat at home until nest after pm2 stop (nested layout only)
    if (isValidRepo(home, version)) {
      ensureNpmInstall(home, PEER_DIR_NAME[version]);
      savePathCache({ [version]: home, runtimeHome: home });
      return home;
    }
  }

  // For flat layout, check if the flat dest is already valid
  if (isFlat && isRunnableRepo(dest, version)) {
    savePathCache({ [version]: dest, runtimeHome: home });
    return dest;
  }

  if (isRunnableRepo(dest, version)) {
    savePathCache({ [version]: dest, runtimeHome: home });
    return dest;
  }

  if (isValidRepo(dest, version)) {
    ensureNpmInstall(dest, destLabel);
    savePathCache({ [version]: dest, runtimeHome: home });
    return dest;
  }

  // Incomplete / empty dir from a previous failed clone
  if (fs.existsSync(dest)) {
    const hasPkg = fs.existsSync(path.join(dest, "package.json"));
    const hasGit = fs.existsSync(path.join(dest, ".git"));
    if (!hasPkg) {
      console.log(`[versionSwitch] 删除不完整目录 ${dest}`);
      fs.rmSync(dest, { recursive: true, force: true });
    } else if (hasGit && !hasUsableNodeModules(dest)) {
      ensureNpmInstall(dest, destLabel);
      if (isRunnableRepo(dest, version)) {
        savePathCache({ [version]: dest, runtimeHome: home });
        return dest;
      }
    }
  }

  console.log(`[versionSwitch] 准备 ${destLabel} → ${dest}`);
  cloneEdition(version, dest);
  ensureNpmInstall(dest, destLabel);
  if (!isRunnableRepo(dest, version)) {
    throw new Error(`准备 ${version} 失败: ${dest}`);
  }
  savePathCache({ [version]: dest, runtimeHome: home });
  return dest;
}

export function resolveRepoRoots(
  options: { prepareMissing?: boolean } = {},
): Record<TeleBoxVersion, string> {
  return ensureNestedLayout({
    prepareMissing: options.prepareMissing === true,
  }).roots;
}

function isPluginIndex(file: string): boolean {
  if (!file.endsWith("plugins.json") || !fs.existsSync(file)) return false;
  const raw = readJsonSafe(file);
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

export function resolvePluginIndexPath(version: TeleBoxVersion): string | null {
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
      ? ["TeleBox-Plugins", "TeleBox_Plugins", "telebox_plugins", "telebox-plugins"]
      : [
          "TeleBox-Next-Plugins",
          "TeleBox-Next_Plugins", // legacy
          "TeleBox_M_Plugins",
          "telebox_m_plugins",
          "telebox-next_plugins",
          "telebox-next-plugins",
        ];

  const candidates = [
    ...names.map((n) => path.join(PLUGIN_REPOS_DIR, n, "plugins.json")),
    ...names.map((n) => path.join(home, n, "plugins.json")),
    ...names.map((n) => path.join(path.dirname(home), n, "plugins.json")),
  ];
  for (const candidate of candidates) {
    if (isPluginIndex(candidate)) {
      savePathCache({ [cacheKey]: candidate });
      return candidate;
    }
  }

  // No plugin index found — that's fine, plugins are managed by TPM, not switch.
  return null;
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

/**
 * Spawn a long-running switch controller that MUST survive PM2 stop of the bot.
 *
 * Root cause of mid-switch freezes: Node `detached:true` alone does NOT remove
 * the child from PM2's kill tree. When controller runs `pm2 stop telebox`, PM2
 * kills the bot AND every descendant — including the controller. Progress then
 * freezes around "合并插件配置" / "停止当前版本" with no further log lines.
 *
 * Fix: launch via `setsid` so the controller is a new session leader outside
 * the bot process tree; unref the launcher handle.
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
  const node = process.execPath;
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? process.env;
  const stdio = options.stdio ?? "ignore";
  const args = [cli, scriptPath];

  const spawnNode = (): ChildProcess =>
    spawn(node, args, {
      cwd,
      env,
      stdio,
      detached: true,
    });

  // setsid: new session → not in PM2 kill tree of the source bot
  let child: ChildProcess;
  if (fs.existsSync("/usr/bin/setsid") || fs.existsSync("/bin/setsid")) {
    const setsidBin = fs.existsSync("/usr/bin/setsid") ? "/usr/bin/setsid" : "/bin/setsid";
    child = spawn(setsidBin, [node, ...args], {
      cwd,
      env,
      stdio,
      detached: true,
    });
  } else {
    child = spawnNode();
  }

  child.on("error", (err: Error) => {
    console.error(
      `[versionSwitch] failed to spawn ${scriptPath}:`,
      err.message,
    );
  });
  return child;
}

export const PM2_PROCESS_NAMES: Record<TeleBoxVersion, string> = {
  teleproto: "telebox",
  mtcute: "telebox-next",
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
  if (!isRunnableRepo(repoRoot, version)) {
    throw new Error(`PM2 start: 仓库未就绪（缺依赖） ${repoRoot} (${version})`);
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
