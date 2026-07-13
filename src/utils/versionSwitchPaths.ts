/**
 * Path + process helpers for version switch.
 *
 * Never spawn bare "npx"/"tsx" from PATH — PM2 and many user environments have
 * a minimal PATH that yields `spawn npx ENOENT` and crashes the userbot.
 * Always use process.execPath + scripts/run-tsx.cjs under the target repo.
 */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
  type StdioOptions,
} from "child_process";
import fs from "fs";
import path from "path";
import type { TeleBoxVersion } from "./versionSwitchCore";

const TELEPROTO_DIR_NAMES = ["telebox", "TeleBox"];
const MTCUTE_DIR_NAMES = ["telebox_mtcute", "TeleBox_M", "TeleBox_mtcute"];
const TELEPROTO_PLUGIN_DIR_NAMES = ["TeleBox_Plugins", "telebox_plugins"];
const MTCUTE_PLUGIN_DIR_NAMES = ["TeleBox_M_Plugins", "telebox_m_plugins"];

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

function parentOfCwd(): string {
  return path.dirname(process.cwd());
}

/**
 * Resolve absolute path to a TeleBox edition checkout.
 * Order: env TELEBOX_TELEPROTO_ROOT / TELEBOX_MTCUTE_ROOT → cwd if matching → sibling dirs.
 */
export function resolveRepoRoot(version: TeleBoxVersion): string {
  const envKey =
    version === "teleproto" ? "TELEBOX_TELEPROTO_ROOT" : "TELEBOX_MTCUTE_ROOT";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${envKey}=${fromEnv} does not exist`);
    }
    return resolved;
  }

  const names = version === "teleproto" ? TELEPROTO_DIR_NAMES : MTCUTE_DIR_NAMES;
  const cwd = process.cwd();
  const base = path.basename(cwd);
  if (names.includes(base) && fs.existsSync(path.join(cwd, "package.json"))) {
    return cwd;
  }

  const sibling = firstExisting(names.map((name) => path.join(parentOfCwd(), name)));
  if (sibling) return sibling;

  throw new Error(
    `无法定位 ${version} 仓库目录。请设置环境变量 ${envKey} 为绝对路径。`,
  );
}

export function resolveRepoRoots(): Record<TeleBoxVersion, string> {
  return {
    teleproto: resolveRepoRoot("teleproto"),
    mtcute: resolveRepoRoot("mtcute"),
  };
}

/** Absolute path to plugins.json for an edition. */
export function resolvePluginIndexPath(version: TeleBoxVersion): string {
  const envKey =
    version === "teleproto"
      ? "TELEBOX_TELEPROTO_PLUGINS"
      : "TELEBOX_MTCUTE_PLUGINS";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${envKey}=${fromEnv} does not exist`);
    }
    return resolved;
  }

  const names =
    version === "teleproto"
      ? TELEPROTO_PLUGIN_DIR_NAMES
      : MTCUTE_PLUGIN_DIR_NAMES;
  const bases = [
    parentOfCwd(),
    path.dirname(resolveRepoRoot(version)),
    process.cwd(),
  ];
  const candidates: string[] = [];
  for (const base of bases) {
    for (const name of names) {
      candidates.push(path.join(base, name, "plugins.json"));
      candidates.push(path.join(base, name)); // allow pointing at file via env only; skip if dir
    }
  }
  for (const candidate of candidates) {
    if (candidate.endsWith("plugins.json") && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  throw new Error(
    `无法定位 ${version} 的 plugins.json。请设置 ${envKey} 为 plugins.json 的绝对路径。`,
  );
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
