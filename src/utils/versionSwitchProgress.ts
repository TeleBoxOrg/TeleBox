/**
 * Live progress for `.switch go`.
 *
 * Design (production):
 * - Controller writes progress to ~/.telebox-switch/progress.json (no second MTProto session).
 * - Source bot polls that file and edits the original message with its live client.
 * - After source PM2 stop, poller dies; target runtimeManager writes the final result.
 * - Long work (clone / npm / convert) happens BEFORE stop → user always sees updates.
 */
import fs from "fs";
import path from "path";
import type { TeleBoxVersion } from "./versionSwitchState";
import { DEFAULT_SWITCH_HOME } from "./versionSwitchState";

export type ProgressStatus = "pending" | "running" | "done" | "skip" | "fail";

export interface ProgressStep {
  id: string;
  title: string;
  status: ProgressStatus;
  detail?: string;
}

export interface SwitchProgressSnapshot {
  source: TeleBoxVersion;
  target: TeleBoxVersion;
  steps: ProgressStep[];
  footer?: string;
  failed?: boolean;
  done?: boolean;
  text: string;
  updatedAt: number;
}

export const DEFAULT_SWITCH_STEPS: Array<{ id: string; title: string }> = [
  { id: "layout", title: "准备目标版本（下载/依赖）" },
  { id: "convert", title: "转换 session（无需重新登录）" },
  { id: "plugins", title: "同步插件到目标版本" },
  { id: "archive", title: "归档仅当前版有的插件" },
  { id: "configs", title: "合并插件配置" },
  { id: "stop", title: "停止当前版本" },
  { id: "nest", title: "整理运行目录" },
  { id: "start", title: "启动目标版本" },
  { id: "ready", title: "等待目标版本上线" },
];

const EMOJI: Record<TeleBoxVersion, string> = {
  teleproto: "🟦",
  mtcute: "🟧",
};

function label(v: TeleBoxVersion): string {
  return v === "teleproto" ? "TeleBox Classic" : "TeleBox-Next";
}

function statusIcon(status: ProgressStatus): string {
  switch (status) {
    case "done":
      return "✅";
    case "running":
      return "⏳";
    case "skip":
      return "⏭️";
    case "fail":
      return "❌";
    default:
      return "⬜";
  }
}

export function progressFile(home = DEFAULT_SWITCH_HOME): string {
  return path.join(home, "progress.json");
}

export function formatSwitchProgress(opts: {
  source: TeleBoxVersion;
  target: TeleBoxVersion;
  steps: ProgressStep[];
  footer?: string;
  failed?: boolean;
}): string {
  const { source, target, steps, footer, failed } = opts;
  const header = failed ? `❌ **切换失败**` : `🔄 **正在切换**`;
  const lines = [
    header,
    ``,
    `${EMOJI[source]} ${label(source)}  →  ${EMOJI[target]} ${label(target)}`,
    ``,
    ...steps.map((s) => {
      const icon = statusIcon(s.status);
      const detail =
        s.detail != null && s.detail !== ""
          ? ` — ${s.detail}`
          : s.status === "running"
            ? "…"
            : "";
      return `${icon} ${s.title}${detail}`;
    }),
  ];
  if (footer) {
    lines.push(``, footer);
  } else if (!failed) {
    const running = steps.find((s) => s.status === "running");
    if (running) lines.push(``, `当前：${running.title}`);
    lines.push(``, `_进度实时更新；完成后本条消息会显示结果。_`);
  }
  return lines.join("\n");
}

export function createSteps(
  defs: Array<{ id: string; title: string }> = DEFAULT_SWITCH_STEPS,
): ProgressStep[] {
  return defs.map((d) => ({ ...d, status: "pending" as const }));
}

export function writeProgressSnapshot(
  snap: SwitchProgressSnapshot,
  home = DEFAULT_SWITCH_HOME,
): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = progressFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readProgressSnapshot(
  home = DEFAULT_SWITCH_HOME,
): SwitchProgressSnapshot | null {
  try {
    const file = progressFile(home);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SwitchProgressSnapshot;
    if (!raw || typeof raw.text !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function clearProgressSnapshot(home = DEFAULT_SWITCH_HOME): void {
  try {
    const file = progressFile(home);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}


/** Marker that a version switch is actively running (controller alive or about to run). */
export function switchInProgressLock(home = DEFAULT_SWITCH_HOME): string {
  return path.join(home, "in-progress.lock");
}

export function markSwitchInProgress(
  meta: { source: TeleBoxVersion; target: TeleBoxVersion; reason?: string },
  home = DEFAULT_SWITCH_HOME,
): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    switchInProgressLock(home),
    JSON.stringify(
      {
        ...meta,
        pid: process.pid,
        startedAt: Date.now(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export function clearSwitchInProgress(home = DEFAULT_SWITCH_HOME): void {
  try {
    const file = switchInProgressLock(home);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * True while `.switch go` is running.
 * Used by Memory Monitor to avoid killing the bot mid-switch (progress would freeze).
 * Stale locks older than 40 minutes are ignored.
 */
export function isSwitchInProgress(home = DEFAULT_SWITCH_HOME): boolean {
  try {
    const lock = switchInProgressLock(home);
    if (fs.existsSync(lock)) {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs < 40 * 60 * 1000) return true;
      // stale
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
    const snap = readProgressSnapshot(home);
    if (snap && !snap.done && !snap.failed) {
      if (Date.now() - (snap.updatedAt || 0) < 40 * 60 * 1000) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}


/** Controller-side reporter: only writes progress.json (bot process edits Telegram). */
export class SwitchProgressReporter {
  private steps: ProgressStep[];
  private source: TeleBoxVersion;
  private target: TeleBoxVersion;
  private failed = false;
  private finished = false;
  private lastText = "";

  constructor(source: TeleBoxVersion, target: TeleBoxVersion) {
    this.source = source;
    this.target = target;
    this.steps = createSteps();
  }

  async init(): Promise<void> {
    this.flush("已启动切换进程…");
  }

  private flush(footer?: string): void {
    const text = formatSwitchProgress({
      source: this.source,
      target: this.target,
      steps: this.steps,
      footer,
      failed: this.failed,
    });
    if (text === this.lastText && !footer) return;
    this.lastText = text;
    writeProgressSnapshot({
      source: this.source,
      target: this.target,
      steps: this.steps,
      footer,
      failed: this.failed,
      done: this.finished,
      text,
      updatedAt: Date.now(),
    });
    console.log(
      `[progress] ${this.steps.find((s) => s.status === "running")?.id ?? "—"} ${footer ?? ""}`.trim(),
    );
  }

  async set(
    id: string,
    status: ProgressStatus,
    detail?: string,
  ): Promise<void> {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    if (status === "running") {
      for (const s of this.steps) {
        if (s.id === id) break;
        if (s.status === "running") s.status = "done";
      }
    }
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    if (status === "fail") this.failed = true;
    this.flush();
  }

  async skip(id: string, detail?: string): Promise<void> {
    await this.set(id, "skip", detail);
  }

  async fail(message: string): Promise<void> {
    this.failed = true;
    this.finished = true;
    clearSwitchInProgress();
    const running = this.steps.find((s) => s.status === "running");
    if (running) {
      running.status = "fail";
      running.detail = message;
    }
    this.flush(`错误：${message}`);
  }

  async done(extra?: string): Promise<void> {
    for (const s of this.steps) {
      if (s.status === "running" || s.status === "pending") s.status = "done";
    }
    this.finished = true;
    clearSwitchInProgress();
    this.flush(
      extra ?? "目标版本正在启动，完成后本条消息会显示最终结果。",
    );
  }

  async close(): Promise<void> {
    // Keep last snapshot for bot poller / post-mortem; runtimeManager may clear.
  }
}

/**
 * Resolve a stable numeric chat id for teleproto Message (peerId is an object).
 */
export function resolveTeleprotoChatId(msg: {
  chatId?: unknown;
  peerId?: unknown;
  senderId?: unknown;
}): number | null {
  if (msg.chatId != null && msg.chatId !== "") {
    const n = Number(msg.chatId);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  const peer = msg.peerId as
    | { userId?: unknown; channelId?: unknown; chatId?: unknown }
    | null
    | undefined;
  if (peer && typeof peer === "object") {
    const raw = peer.userId ?? peer.channelId ?? peer.chatId;
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  if (msg.senderId != null && msg.senderId !== "") {
    const n = Number(msg.senderId);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}
