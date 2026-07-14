import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/runtimeManager";
import { updateAllPlugins } from "./tpm";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getErrorMessage(error: any): string {
  if (!error) return "";
  return (error.stderr as string) || (error.message as string) || String(error);
}

// ── Cross-restart autofix state ────────────────────────────────────────
// autofix spans a restart: steps 1-3 (dedupe / reset / restart) run on the
// OLD process; steps 4-5 (plugin update / summary) run on the NEW process.
// Persist the target message + start time so resumeAutofix() can finish the
// job once the new runtime is fully online.
const AUTOFIX_STATE_FILE = path.join(os.homedir(), ".telebox", "autofix.json");

interface AutofixState {
  chatId: string;
  msgId: number;
  startTime: number;
  removed: string[];
}

function saveAutofixState(state: AutofixState): void {
  try {
    fs.mkdirSync(path.dirname(AUTOFIX_STATE_FILE), { recursive: true });
    fs.writeFileSync(AUTOFIX_STATE_FILE, JSON.stringify(state), "utf8");
  } catch (e) {
    console.error("[autofix] 保存状态失败:", e);
  }
}

function loadAutofixState(): AutofixState | null {
  try {
    if (!fs.existsSync(AUTOFIX_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(AUTOFIX_STATE_FILE, "utf8"));
    if (raw && typeof raw.chatId === "string" && typeof raw.msgId === "number") {
      return raw as AutofixState;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function clearAutofixState(): void {
  try {
    if (fs.existsSync(AUTOFIX_STATE_FILE)) fs.unlinkSync(AUTOFIX_STATE_FILE);
  } catch {
    /* ignore */
  }
}

// ── Git helper (identity injected so reset/merge never fails) ───────────
async function gitExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", [
    "-c", "user.name=TeleBox Autofix",
    "-c", "user.email=telebox@users.noreply.github.com",
    ...args,
  ], { cwd: process.cwd() });
}

// ── Step 1: remove user plugins colliding with system plugin names ──────
// System plugins live in src/plugin/, user plugins in plugins/. A user
// plugin whose basename matches a system plugin shadows it and can break
// core commands — remove it.
function removeCollidingPlugins(): string[] {
  const userDir = path.join(process.cwd(), "plugins");
  const sysDir = path.join(process.cwd(), "src", "plugin");
  if (!fs.existsSync(userDir) || !fs.existsSync(sysDir)) return [];

  const sysNames = new Set(
    fs.readdirSync(sysDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.basename(f, ".ts")),
  );

  const removed: string[] = [];
  for (const f of fs.readdirSync(userDir)) {
    if (!f.endsWith(".ts")) continue;
    const name = path.basename(f, ".ts");
    if (sysNames.has(name)) {
      try {
        fs.unlinkSync(path.join(userDir, f));
        removed.push(name);
        console.log(`[autofix] 移除与系统插件重名的插件: ${name}`);
      } catch (e) {
        console.warn(`[autofix] 移除插件 ${name} 失败:`, e);
      }
    }
  }
  return removed;
}

// ── Post-restart resume: steps 4-5 (update plugins + summary) ───────────
/** Called from runtimeManager once the new runtime is fully online. */
export async function resumeAutofix(): Promise<void> {
  const state = loadAutofixState();
  if (!state) return;
  // Clear early so a crash mid-resume can't loop forever.
  clearAutofixState();

  try {
    // Step 4: update all installed plugins to latest (silent, no progress spam).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeMsg = { chatId: state.chatId, id: state.msgId } as any;
    await updateAllPlugins(fakeMsg, { silent: true });

    // Step 5: summary.
    const elapsedMs = Date.now() - state.startTime;
    const client = await getGlobalClient();
    await client.editMessage(state.chatId, {
      message: state.msgId,
      text: `✅ 修复成功，用时 ${elapsedMs}ms`,
    });
    console.log(`[autofix] 修复完成，用时 ${elapsedMs}ms`);
  } catch (e) {
    console.error("[autofix] 重启后续步骤失败:", e);
    try {
      const client = await getGlobalClient();
      await client.editMessage(state.chatId, {
        message: state.msgId,
        text: `❌ 修复过程出错：${getErrorMessage(e) || String(e)}`,
      });
    } catch {
      /* ignore */
    }
  }
}

// ── Command entry: steps 1-3 (dedupe / reset / restart) ─────────────────
async function handleAutofix(msg: Api.Message): Promise<void> {
  const startTime = Date.now();
  await msg.edit({ text: "🔧 正在修复：移除重名插件…" });

  try {
    // Step 1
    const removed = removeCollidingPlugins();

    // Step 2: hard-sync main code to remote.
    await msg.edit({ text: "🔧 正在修复：同步远程代码…" });
    await gitExec(["fetch", "origin"]);
    await gitExec(["reset", "--hard", "origin/main"]);

    // Step 3: persist state, then restart. Steps 4-5 continue post-restart
    // via resumeAutofix() so the summary reflects the fully-restarted state.
    const chatId = msg.chatId != null ? String(msg.chatId) : (msg.peerId != null ? String(msg.peerId) : null);
    if (chatId == null || msg.id == null) {
      throw new Error("无法定位当前消息，无法记录修复状态");
    }
    saveAutofixState({
      chatId,
      msgId: msg.id,
      startTime,
      removed,
    });

    // Restart directly (do NOT use executeExit — its own exitFile would edit
    // this same message to "✅ 重启完成" and collide with our "✅ 修复成功"
    // summary written by resumeAutofix() after boot).
    await msg.edit({ text: "🔧 代码已同步，正在重启并更新插件…" });
    console.log("[autofix] 步骤 1-3 完成，重启进程…");
    process.exit(0);
  } catch (error: unknown) {
    clearAutofixState();
    const detail = getErrorMessage(error) || String(error);
    console.error("[autofix] 修复失败:", detail);
    try {
      await msg.edit({ text: `❌ 修复失败：${detail}` });
    } catch {
      /* ignore */
    }
  }
}

class AutofixPlugin extends Plugin {
  description: string = `一键修复：移除重名插件 → 硬同步远程代码 → 重启 → 更新插件\n<code>${mainPrefix}autofix</code>`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    autofix: handleAutofix,
  };
}

export default new AutofixPlugin();
