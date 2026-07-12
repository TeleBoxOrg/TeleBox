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
async function getRemotes(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote"]);
    return stdout.trim().split("\n").filter((r) => r.trim());
  } catch {
    return [];
  }
}

async function getBranches(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "-r"]);
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

    await execFileAsync("git", ["fetch", "--all"]);
    await msg.edit({ text: "🔄 正在拉取最新代码..." });

    if (force) {
      console.log(`⚠️ 强制回滚到 ${fullBranch}...`);
      await execFileAsync("git", ["reset", "--hard", fullBranch]);
      await msg.edit({ text: "🔄 强制更新中..." });
    }

    await execFileAsync("git", ["pull", remote, branch, "--no-rebase"]);
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
async function autoUpdateMainRepo(githubMsg: Api.Message): Promise<void> {
  let statusMsg: Api.Message | undefined;
  try {
    statusMsg = await githubMsg.reply({ message: "🤖 自动更新：检测到主仓库新提交，正在更新…" });
    if (!statusMsg) throw new Error("无法发送状态消息");

    // Snapshot peerId+msgId before any blocking operation — npm_install_project_dependencies()
    // uses execFileSync (synchronous), which blocks the event loop and can cause the teleproto
    // connection to drop. After that, statusMsg._client is stale and statusMsg.delete() fails
    // silently (caught by catch(_){}). Same root cause as the plugin auto-update bug (21de22c).
    const targetPeerId = statusMsg.peerId;
    const targetMsgId = statusMsg.id;

    const branchInfo = await findMainBranch();
    if (!branchInfo) {
      throw new Error("未找到可用的远程分支");
    }
    const { remote, branch } = branchInfo;

    await execFileAsync("git", ["fetch", "--all"]);
    await execFileAsync("git", ["pull", remote, branch, "--no-rebase"]);
    await npm_install_project_dependencies();

    // Success — delete status message using a fresh client, then restart silently.
    // statusMsg.delete() may fail because the client connection died during npm install.
    await deleteStatusMessage(targetPeerId, targetMsgId);
    await executeAutoExit();
  } catch (error: any) {
    const errDetail = getErrorMessage(error);
    if (statusMsg) {
      try {
        await statusMsg.edit({ text: `❌ 自动更新失败：${errDetail}` });
      } catch (_) {}
    } else {
      try { await githubMsg.reply({ message: `❌ 自动更新失败：${errDetail}` }); } catch (_) {}
    }
  }
}

/**
 * Delete a status message using a fresh client from getGlobalClient().
 * The original message object's _client may be stale after a long blocking
 * operation (e.g. npm_install_project_dependencies uses execFileSync).
 * Includes a 2s-delayed retry — the client may need a moment to reconnect.
 */
async function deleteStatusMessage(peerId: any, msgId: number): Promise<void> {
  try {
    const freshClient = await getGlobalClient();
    await (freshClient as any).deleteMessages(peerId, [msgId], { revoke: true });
    console.log("[auto-update] 状态消息已删除");
  } catch (err: any) {
    console.error("[auto-update] 删除状态消息失败:", err?.message || err);
    // Retry once after a short delay — the client may need a moment to reconnect
    // after the long synchronous npm install blocked the event loop.
    try {
      await new Promise((r) => setTimeout(r, 2000));
      const freshClient = await getGlobalClient();
      await (freshClient as any).deleteMessages(peerId, [msgId], { revoke: true });
      console.log("[auto-update] 状态消息删除重试成功");
    } catch (retryErr: any) {
      console.error("[auto-update] 状态消息删除重试失败:", retryErr?.message || retryErr);
    }
  }
}

async function executeAutoExit(): Promise<void> {
  // Minimal restart: just exit the process. pm2 will restart it.
  // No message tracking needed — we already deleted the status message.
  console.log("[auto-update] 更新完成，退出进程…");
  process.exit(0);
}

// ── Auto-update for plugin repos ───────────────────────────────────────
async function autoUpdatePlugins(githubMsg: Api.Message): Promise<void> {
  try {
    const statusMsg = (await githubMsg.reply({ message: "🤖 自动更新：检测到插件仓库新提交，正在更新插件…" }))!;
    // Snapshot before updateAllPlugins → reloadAndFinalize → loadPlugins()
    // (plugin reload invalidates statusMsg's internal _client reference)
    const fallbackPeerId = statusMsg.peerId;
    const fallbackMsgId = statusMsg.id;

    const result = await updateAllPlugins(statusMsg);

    if (result.failedCount === 0) {
      // Use the status message info returned by updateAllPlugins — it may
      // differ from the original snapshot if sendOrEditMessage created a new
      // message (when edit failed). reloadAndFinalize already called
      // loadPlugins() → reloadRuntime(), so the old client is dead and a new
      // one is alive.
      const targetPeerId = result.statusPeerId ?? fallbackPeerId;
      const targetMsgId = result.statusMsgId ?? fallbackMsgId;
      try {
        const freshClient = await getGlobalClient();
        await (freshClient as any).deleteMessages(targetPeerId, [targetMsgId], { revoke: true });
        console.log("[auto-update] 插件更新完成，状态消息已删除");
      } catch (err: any) {
        console.error("[auto-update] 删除状态消息失败:", err?.message || err);
        // Retry once after a short delay — the new client may need a moment
        // to fully establish its entity cache after reloadRuntime().
        try {
          await new Promise((r) => setTimeout(r, 2000));
          const freshClient = await getGlobalClient();
          await (freshClient as any).deleteMessages(targetPeerId, [targetMsgId], { revoke: true });
          console.log("[auto-update] 状态消息删除重试成功");
        } catch (retryErr: any) {
          console.error("[auto-update] 状态消息删除重试失败:", retryErr?.message || retryErr);
        }
      }
    }
  } catch (error: any) {
    console.error("[auto-update] 插件更新异常:", getErrorMessage(error));
  }
}

// ── GitHubBot message parsing ──────────────────────────────────────────
const GITHUB_CHANNEL_ID = "-1003061608291";

// Regex to match commit notifications:
//   "new commit <sha> to <repo>:<branch>" (English)
//   or Chinese/other variants
const MAIN_REPO_PATTERN = /new commit.*to\s+(TeleBox|TeleBox_M)\s*:\s*main/i;
const PLUGIN_REPO_PATTERN = /new commit.*to\s+(TeleBox_Plugins|TeleBox_M_Plugins)\s*:\s*main/i;

class UpdatePlugin extends Plugin {
  description: string =
    `更新项目：拉取最新代码并安装依赖\n` +
    `<code>${mainPrefix}update -f/-force</code> 强制更新\n` +
    `<code>${mainPrefix}update auto on</code> / <code>off</code> 自动更新开关（默认关闭）`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    update: async (msg) => {
      const parts = msg.message.slice(1).split(" ").slice(1);

      // update auto on/off
      if (parts[0] === "auto") {
        const sub = parts[1]?.toLowerCase();
        if (sub === "on") {
          saveAutoUpdateState({ enabled: true });
          await msg.edit({ text: "✅ 自动更新已开启\n\n检测到主仓库提交时自动 git pull + 重启，检测到插件仓库提交时自动 tpm update。" });
          return;
        }
        if (sub === "off") {
          saveAutoUpdateState({ enabled: false });
          await msg.edit({ text: "🔒 自动更新已关闭" });
          return;
        }
        // show status
        const state = loadAutoUpdateState();
        await msg.edit({ text: `自动更新状态：${state.enabled ? "✅ 开启" : "🔒 关闭"}\n\n使用 <code>${mainPrefix}update auto on/off</code> 切换` });
        return;
      }

      const force = parts.includes("--force") || parts.includes("-f");
      await update(force, msg);
    },
  };

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    const state = loadAutoUpdateState();
    if (!state.enabled) return;

    // Only in the target channel
    if (String(msg.chatId) !== GITHUB_CHANNEL_ID) return;

    // Only from GitHubBot
    if ((msg.sender as any)?.username !== "GitHubBot") return;

    const text = msg.message || "";
    if (!text) return;

    if (MAIN_REPO_PATTERN.test(text)) {
      console.log("[auto-update] 检测到主仓库提交，开始自动更新…");
      await autoUpdateMainRepo(msg);
    } else if (PLUGIN_REPO_PATTERN.test(text)) {
      console.log("[auto-update] 检测到插件仓库提交，开始自动更新插件…");
      await autoUpdatePlugins(msg);
    }
  };
}

export default new UpdatePlugin();
