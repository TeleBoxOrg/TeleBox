import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { execFile } from "child_process";
import { promisify } from "util";
import { Api } from "teleproto";
import { npm_install_project_dependencies } from "@utils/npm_install";
import { getGlobalClient } from "@utils/runtimeManager";
import { executeExit } from "./reload";
import { updateAllPlugins } from "./tpm";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const execFileAsync = promisify(execFile);

// ── Auto-update state ──────────────────────────────────────────────────
const AUTO_UPDATE_STATE_DIR = path.join(os.homedir(), ".telebox");
const AUTO_UPDATE_STATE_FILE = path.join(AUTO_UPDATE_STATE_DIR, "auto_update.json");

interface AutoUpdateState {
  enabled: boolean;
}

function loadAutoUpdateState(): AutoUpdateState {
  try {
    if (fs.existsSync(AUTO_UPDATE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(AUTO_UPDATE_STATE_FILE, "utf8"));
    }
  } catch (e: any) {
    console.warn("[auto-update] 读取状态文件失败:", e?.message || e);
  }
  return { enabled: false };
}

function saveAutoUpdateState(state: AutoUpdateState): void {
  try {
    fs.mkdirSync(AUTO_UPDATE_STATE_DIR, { recursive: true });
    fs.writeFileSync(AUTO_UPDATE_STATE_FILE, JSON.stringify(state), "utf8");
  } catch (e: any) {
    console.error("[auto-update] 保存状态文件失败:", e?.message || e);
  }
}

// ── Git helpers ────────────────────────────────────────────────────────
const GIT_USER_NAME = "TeleBox Auto-Update";
const GIT_USER_EMAIL = "telebox@users.noreply.github.com";

async function gitExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // Inject identity so git pull (which may create merge commits) doesn't fail
  // on machines without global git config.
  return execFileAsync("git", [
    "-c", `user.name=${GIT_USER_NAME}`,
    "-c", `user.email=${GIT_USER_EMAIL}`,
    ...args,
  ]);
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
    const branches = stdout
      .trim()
      .split("\n")
      .map((b) => b.trim().replace(/^\*/, "").trim())
      .filter((b) => b && !b.includes("->"));
    return branches;
  } catch {
    return [];
  }
}

async function findMainBranch(): Promise<{ remote: string; branch: string } | null> {
  const branches = await getBranches();
  const allRemotes = await getRemotes();
  const mainBranchNames = ["main", "master"];

  const remotes = allRemotes.includes("origin")
    ? ["origin", ...allRemotes.filter((r) => r !== "origin")]
    : allRemotes;

  for (const branchName of mainBranchNames) {
    for (const remote of remotes) {
      const fullBranch = `${remote}/${branchName}`;
      if (branches.includes(fullBranch)) {
        return { remote, branch: branchName };
      }
      if (branches.includes(branchName)) {
        return { remote, branch: branchName };
      }
    }
  }

  return null;
}

function getErrorMessage(error: any): string {
  if (!error) return "未知错误";
  const errObj = error as Record<string, unknown>;
  return (errObj.stderr as string) || (errObj.message as string) || String(error);
}

// ── Manual update (existing) ───────────────────────────────────────────
async function update(force = false, msg: Api.Message) {
  await msg.edit({ text: "🚀 正在更新项目..." });
  console.clear();
  console.log("🚀 开始更新项目...\n");

  try {
    const branchInfo = await findMainBranch();
    if (!branchInfo) {
      throw new Error("未找到可用的远程分支 (main/master)。请确保已配置 git remote。");
    }

    const { remote, branch } = branchInfo;
    const fullBranch = `${remote}/${branch}`;

    await gitExec(["fetch", "--all"]);
    await msg.edit({ text: "🔄 正在拉取最新代码..." });

    if (force) {
      console.log(`⚠️ 强制回滚到 ${fullBranch}...`);
      await gitExec(["reset", "--hard", fullBranch]);
      await msg.edit({ text: "🔄 强制更新中..." });
    }

    await gitExec(["pull", remote, branch, "--no-rebase"]);
    await msg.edit({ text: "🔄 正在合并最新代码..." });

    console.log("\n📦 安装依赖...");
    await msg.edit({ text: "📦 正在安装依赖..." });
    await npm_install_project_dependencies();

    console.log("\n✅ 更新完成。");

    await executeExit(msg, {
      pendingText: "🔄 正在重启进程...",
      successText: "✅ 更新完成，耗时 {elapsedMs}ms",
    });
  } catch (error: any) {
    console.error("❌ 更新失败:", error);

    const errCmd = error.cmd || "";
    const errDetail = error.stderr || error.message || String(error);

    const errorText =
      `❌ 更新失败\n` +
      (errCmd ? `失败命令行：${errCmd}\n` : "") +
      `失败原因：${errDetail}\n\n` +
      "如果是 Git 冲突，请手动解决后再更新，或使用 .update -f 强制更新（会丢弃本地改动）";

    try {
      await msg.edit({ text: errorText });
    } catch (editError) {
      console.error("Failed to send error message after update failure:", editError);
      try {
        const client = await getGlobalClient();
        const targetChat = msg.chatId || msg.peerId;
        if (client && targetChat) {
          await client.sendMessage(targetChat, { message: errorText });
        }
      } catch (sendError) {
        console.error("Failed to send error via fallback client:", sendError);
      }
    }
  }
}

// ── Auto-update for main repo ──────────────────────────────────────────
/** React ✅ on GitHubBot commit message (success signal; no chat spam).
 * MUST be called while the MTProto connection is still healthy — i.e. BEFORE
 * any synchronous, event-loop-blocking work (npm install) and BEFORE
 * process.exit(). Retries a few times to ride out transient reconnects. */
async function reactSuccessOnGithubMsg(githubMsg: Api.Message): Promise<void> {
  const peer = githubMsg.peerId ?? (githubMsg.chatId != null ? String(githubMsg.chatId) : undefined);
  if (peer == null || githubMsg.id == null) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const client = await getGlobalClient();
      await client.sendReaction(peer, githubMsg.id, [
        new Api.ReactionEmoji({ emoticon: "✅" }),
      ]);
      console.log(`[auto-update] ✅ reaction on msg ${githubMsg.id}`);
      return;
    } catch (e: any) {
      console.warn(`[auto-update] ✅ reaction failed (attempt ${attempt}/3):`, e?.message || e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function autoUpdateMainRepo(githubMsg: Api.Message): Promise<void> {
  // Silent success path: no status replies. Errors only.
  try {
    const branchInfo = await findMainBranch();
    if (!branchInfo) {
      throw new Error("未找到可用的远程分支");
    }
    const { remote, branch } = branchInfo;

    await gitExec(["fetch", "--all"]);
    await gitExec(["pull", remote, branch, "--no-rebase"]);

    // Pull succeeded → update is already on disk and the connection is still
    // healthy. React NOW, before the synchronous npm install blocks the event
    // loop (which stalls MTProto heartbeats and kills the connection) and
    // before process.exit(). Reacting after install is why ✅ never landed.
    await reactSuccessOnGithubMsg(githubMsg);

    await npm_install_project_dependencies();

    await executeAutoExit();
  } catch (error: any) {
    const errDetail = getErrorMessage(error);
    console.error("[auto-update] 主仓库更新失败:", errDetail);
    try {
      await githubMsg.reply({ message: `❌ 自动更新失败：${errDetail}` });
    } catch (_) {}
  }
}

async function executeAutoExit(): Promise<void> {
  console.log("[auto-update] 更新完成，退出进程…");
  process.exit(0);
}

// ── Auto-update for plugin repos ───────────────────────────────────────
async function autoUpdatePlugins(githubMsg: Api.Message): Promise<void> {
  try {
    // Silent: updateAllPlugins still needs a message object for internal edits.
    // We pass githubMsg but use silent mode so it never posts progress to the group.
    const result = await updateAllPlugins(githubMsg, { silent: true });

    if (result.failedCount === 0) {
      await reactSuccessOnGithubMsg(githubMsg);
      return;
    }
    // Partial/full failure — surface error only
    try {
      await githubMsg.reply({
        message: `❌ 插件自动更新失败：${result.failedCount} 个插件更新失败`,
      });
    } catch (_) {}
  } catch (error: any) {
    const errDetail = getErrorMessage(error);
    console.error("[auto-update] 插件更新异常:", errDetail);
    try {
      await githubMsg.reply({ message: `❌ 插件自动更新失败：${errDetail}` });
    } catch (_) {}
  }
}

// ── GitHubBot message parsing ──────────────────────────────────────────
// Product channel (legacy) + any group/channel where GitHubBot posts (e.g. telebox 群绑定)
/** Legacy product channel (no longer required; any chat with GitHubBot works). */
const _GITHUB_CHANNEL_ID_LEGACY = "-1003061608291";
void _GITHUB_CHANNEL_ID_LEGACY;
const GITHUB_BOT_USER_ID = "107550100";
const GITHUB_BOT_USERNAME = "githubbot";

// Classic edition only reacts to classic repos (not TeleBox-Next*).
// Accept TeleBoxOrg / TeleBoxLabs / bare names. Plugin pattern first.
// GitHubBot: "1 new commit to …" / "2 new commits to …" (singular or plural)
const COMMIT_NOTICE_PATTERN = /\bnew\s+commits?\b/i;
const MAIN_REPO_PATTERN =
  /\bnew\s+commits?\b[\s\S]*?\bto\s+(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox|TeleBox_M)\s*:\s*main\b/i;
const PLUGIN_REPO_PATTERN =
  /\bnew\s+commits?\b[\s\S]*?\bto\s+(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Plugins|TeleBox_Plugins|TeleBox_M_Plugins)\s*:\s*main\b/i;

function normalizeChatId(msg: Api.Message): string {
  if (msg.chatId != null) return String(msg.chatId);
  const peer = msg.peerId as
    | { className?: string; channelId?: { toString(): string }; userId?: { toString(): string }; chatId?: { toString(): string } }
    | undefined;
  if (peer?.channelId != null) return `-100${String(peer.channelId)}`;
  if (peer?.userId != null) return String(peer.userId);
  if (peer?.chatId != null) {
    const id = String(peer.chatId);
    return id.startsWith("-") ? id : `-${id}`;
  }
  return "";
}

function isGitHubBot(msg: Api.Message): boolean {
  const sid = msg.senderId != null ? String(msg.senderId) : "";
  if (sid && sid === GITHUB_BOT_USER_ID) return true;
  const uname = String((msg.sender as { username?: string } | undefined)?.username || "")
    .toLowerCase()
    .replace(/^@/, "");
  if (uname === GITHUB_BOT_USERNAME) return true;
  const from = msg.fromId as { userId?: { toString(): string } } | undefined;
  if (from?.userId != null && String(from.userId) === GITHUB_BOT_USER_ID) return true;
  return false;
}

class UpdatePlugin extends Plugin {
  description: string =
    `更新项目：拉取最新代码并安装依赖\n` +
    `<code>${mainPrefix}update -f/-force</code> 强制更新\n` +
    `<code>${mainPrefix}update auto on</code> / <code>off</code> 自动更新开关（默认关闭）`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    update: async (msg) => {
      const parts = msg.message.slice(1).split(" ").slice(1);

      if (parts[0] === "auto") {
        const sub = parts[1]?.toLowerCase();
        if (sub === "on") {
          saveAutoUpdateState({ enabled: true });
          await msg.edit({
            text:
              "✅ 自动更新已开启\n\n" +
              "任意会话中 GitHubBot 推送 Classic 仓库（TeleBox / TeleBox-Plugins，含 TeleBoxLabs 镜像）提交时自动更新。\n" +
              "成功：仅在 commit 消息上 ✅；失败：回复错误。",
          });
          return;
        }
        if (sub === "off") {
          saveAutoUpdateState({ enabled: false });
          await msg.edit({ text: "🔒 自动更新已关闭" });
          return;
        }
        const state = loadAutoUpdateState();
        await msg.edit({
          text: `自动更新状态：${state.enabled ? "✅ 开启" : "🔒 关闭"}\n\n使用 <code>${mainPrefix}update auto on/off</code> 切换`,
        });
        return;
      }

      const force = parts.includes("--force") || parts.includes("-f");
      await update(force, msg);
    },
  };

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    const state = loadAutoUpdateState();
    if (!state.enabled) return;

    // Any chat is OK (channel + 群绑定). Still require GitHubBot + commit text.
    if (!isGitHubBot(msg)) return;

    const text = msg.message || "";
    if (!text || !COMMIT_NOTICE_PATTERN.test(text)) return;

    // Optional log for product channel vs group
    const chatId = normalizeChatId(msg);
    if (PLUGIN_REPO_PATTERN.test(text)) {
      console.log(`[auto-update] chat=${chatId || "?"} 插件仓库提交 → silent update`);
      await autoUpdatePlugins(msg);
    } else if (MAIN_REPO_PATTERN.test(text)) {
      console.log(`[auto-update] chat=${chatId || "?"} 主仓库提交 → silent update`);
      await autoUpdateMainRepo(msg);
    }
  };
}

export default new UpdatePlugin();
