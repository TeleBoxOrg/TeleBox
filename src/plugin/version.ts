import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { readDisplayVersion } from "@utils/teleboxInfoHelper";
import { Api } from "teleproto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execFileAsync = promisify(execFile);

const EDITION_LABEL = "TeleBox";

// ── Git helpers ────────────────────────────────────────────────────────
async function gitExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "git",
    [
      "-c", "user.name=TeleBox",
      "-c", "user.email=telebox@users.noreply.github.com",
      ...args,
    ],
    { cwd: process.cwd() },
  );
}

async function getRemotes(): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["remote"]);
    return stdout.trim().split("\n").filter((r) => r.trim());
  } catch {
    return [];
  }
}

async function getBranches(): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["branch", "-r"]);
    return stdout
      .trim()
      .split("\n")
      .map((b) => b.trim().replace(/^\*/, "").trim())
      .filter((b) => b && !b.includes("->"));
  } catch {
    return [];
  }
}

async function findMainBranch(): Promise<{ remote: string; branch: string } | null> {
  const [branches, allRemotes] = await Promise.all([getBranches(), getRemotes()]);
  const mainBranchNames = ["main", "master"];
  const remotes = allRemotes.includes("origin")
    ? ["origin", ...allRemotes.filter((r) => r !== "origin")]
    : allRemotes;
  for (const branchName of mainBranchNames) {
    for (const remote of remotes) {
      if (branches.includes(`${remote}/${branchName}`)) return { remote, branch: branchName };
      if (branches.includes(branchName)) return { remote, branch: branchName };
    }
  }
  return null;
}

/** true=有更新, false=已最新, null=无法检测 */
async function checkMainRepoUpdate(): Promise<boolean | null> {
  try {
    const branchInfo = await findMainBranch();
    if (!branchInfo) return null;
    const { remote, branch } = branchInfo;
    await gitExec(["fetch", remote, branch]);
    const { stdout } = await gitExec(["rev-list", "--count", `HEAD..${remote}/${branch}`]);
    const behind = parseInt(stdout.trim(), 10);
    if (Number.isNaN(behind)) return null;
    return behind > 0;
  } catch {
    return null;
  }
}

// ── Plugin freshness ───────────────────────────────────────────────────
interface PluginRecord {
  url: string;
  desc?: string;
  _updatedAt?: number;
}

function loadPluginDb(): Record<string, PluginRecord> {
  try {
    const dbPath = path.join(process.cwd(), "assets", "tpm", "plugins.json");
    if (!fs.existsSync(dbPath)) return {};
    return JSON.parse(fs.readFileSync(dbPath, "utf8")) || {};
  } catch {
    return {};
  }
}

function normalizeGithubUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 5 && parts[2] === "blob") {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
      }
      return input;
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      parsed.search = "";
      return parsed.toString();
    }
    return input;
  } catch {
    return input;
  }
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "TeleBox-Version/1.0" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** true=有更新, false=已最新, null=无法检测 */
async function checkPluginsUpdate(): Promise<boolean | null> {
  const db = loadPluginDb();
  const pending = Object.keys(db).filter((n) => db[n]?.url);
  if (pending.length === 0) return false;

  let outdated = false;
  let checked = 0;
  let hadError = false;
  let idx = 0;

  const worker = async (): Promise<void> => {
    while (idx < pending.length && !outdated) {
      const name = pending[idx++];
      const rec = db[name];
      const filePath = path.join(process.cwd(), "plugins", `${name}.ts`);
      if (!fs.existsSync(filePath)) continue;
      const remote = await fetchText(normalizeGithubUrl(rec.url));
      if (remote == null) {
        hadError = true;
        continue;
      }
      checked++;
      const local = fs.readFileSync(filePath, "utf8");
      if (local !== remote) {
        outdated = true;
        return;
      }
    }
  };

  const CONCURRENCY = 6;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
  );

  if (outdated) return true;
  if (checked === 0 && hadError) return null;
  return false;
}

async function handleVersion(msg: Api.Message): Promise<void> {
  await msg.edit({ text: "🔍 正在检查版本..." });

  const display = readDisplayVersion();
  const [mainUpdate, pluginUpdate] = await Promise.all([
    checkMainRepoUpdate(),
    checkPluginsUpdate(),
  ]);

  const mainLine =
    mainUpdate === true
      ? `本体有更新可用，使用 <code>${mainPrefix}update</code> 更新`
      : mainUpdate === false
        ? "本体已是最新版本"
        : "本体更新状态未知（请检查网络或 git 远程）";

  const pluginLine =
    pluginUpdate === true
      ? `插件有更新可用，使用 <code>${mainPrefix}tpm update</code> 更新`
      : pluginUpdate === false
        ? "插件已是最新版本"
        : "插件更新状态未知";

  const text =
    `<b>${EDITION_LABEL} v${display}</b>\n\n` +
    `${mainLine}\n\n` +
    `${pluginLine}`;

  await msg.edit({ text, parseMode: "html" });
}

class VersionPlugin extends Plugin {
  description: string = `查看当前版本号及更新状态\n<code>${mainPrefix}version</code>`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    version: handleVersion,
    ver: handleVersion,
  };
}

export default new VersionPlugin();
