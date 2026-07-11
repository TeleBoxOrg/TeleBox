import fs from "fs";
import os from "os";
import path from "path";
import type { TeleBoxVersion } from "./versionSwitchCore";
export type { TeleBoxVersion };

export interface NativeSessionSelection {
  kind: "native";
}

export interface ExternalSessionSelection {
  kind: "external";
  path: string;
  userId: string;
}

export type SessionSelection = NativeSessionSelection | ExternalSessionSelection;

export interface PendingLogin {
  target: TeleBoxVersion;
  expectedUserId: string;
  phone: string;
  expiresAt: number;
}

export interface SwitchNotification {
  chatId: number;
  msgId: number;
  target: TeleBoxVersion;
}

export interface VersionSwitchState {
  schemaVersion: 1;
  activeVersion: TeleBoxVersion | null;
  sessions: Record<TeleBoxVersion, SessionSelection>;
  pendingTransaction: string | null;
  pendingLogin: PendingLogin | null;
  pendingNotification: SwitchNotification | null;
  stagedSecrets: Partial<Record<"password" | "code", string>>;
}

interface StoredSecret {
  expiresAt: number;
  value: string;
}

export const DEFAULT_SWITCH_HOME = path.join(os.homedir(), ".telebox-switch");

function stateFile(home: string): string {
  return path.join(home, "state.json");
}

function atomicWrite(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

export function createDefaultSwitchState(): VersionSwitchState {
  return {
    schemaVersion: 1,
    activeVersion: null,
    sessions: {
      teleproto: { kind: "native" },
      mtcute: { kind: "native" },
    },
    pendingTransaction: null,
    pendingLogin: null,
    pendingNotification: null,
    stagedSecrets: {},
  };
}

function isSelection(value: unknown): value is SessionSelection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "native") return true;
  return candidate.kind === "external"
    && typeof candidate.path === "string"
    && typeof candidate.userId === "string";
}

function isPendingLogin(value: unknown): value is PendingLogin | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.target === "teleproto" || candidate.target === "mtcute")
    && typeof candidate.expectedUserId === "string"
    && typeof candidate.phone === "string"
    && typeof candidate.expiresAt === "number";
}

function isStagedSecrets(
  value: unknown,
): value is Partial<Record<"password" | "code", string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.entries(candidate).every(([key, secretPath]) =>
    (key === "password" || key === "code") && typeof secretPath === "string"
  );
}

function isSwitchNotification(value: unknown): value is SwitchNotification | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.chatId === "number"
    && typeof candidate.msgId === "number"
    && (candidate.target === "teleproto" || candidate.target === "mtcute");
}

function isState(value: unknown): value is VersionSwitchState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VersionSwitchState>;
  return candidate.schemaVersion === 1
    && (candidate.activeVersion === null
      || candidate.activeVersion === "teleproto"
      || candidate.activeVersion === "mtcute")
    && Boolean(candidate.sessions)
    && isSelection(candidate.sessions?.teleproto)
    && isSelection(candidate.sessions?.mtcute)
    && (candidate.pendingTransaction === null
      || typeof candidate.pendingTransaction === "string")
    && isPendingLogin(candidate.pendingLogin)
    && isSwitchNotification(candidate.pendingNotification)
    && isStagedSecrets(candidate.stagedSecrets);
}

export function loadSwitchState(home = DEFAULT_SWITCH_HOME): VersionSwitchState {
  const file = stateFile(home);
  if (!fs.existsSync(file)) return createDefaultSwitchState();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isState(parsed)) throw new Error(`Invalid switch state: ${file}`);
  return parsed;
}

export function saveSwitchState(
  state: VersionSwitchState,
  home = DEFAULT_SWITCH_HOME,
): void {
  if (!isState(state)) throw new Error("Refusing to write invalid switch state");
  atomicWrite(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
}

export function resolveExternalSessionPath(
  version: TeleBoxVersion,
  home = DEFAULT_SWITCH_HOME,
): string | null {
  const selection = loadSwitchState(home).sessions[version];
  return selection.kind === "external" ? selection.path : null;
}

export function writeSecret(
  value: string,
  ttlMs: number,
  home = DEFAULT_SWITCH_HOME,
): string {
  const dir = path.join(home, "secrets");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(
    dir,
    `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
  const payload: StoredSecret = { expiresAt: Date.now() + ttlMs, value };
  atomicWrite(file, JSON.stringify(payload));
  return file;
}

export function consumeSecret(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSecret>;
    if (typeof parsed.value !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return parsed.expiresAt > Date.now() ? parsed.value : null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}
