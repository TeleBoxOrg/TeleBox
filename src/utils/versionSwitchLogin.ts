#!/usr/bin/env npx tsx
/**
 * teleproto (gramjs) login helper for version switching — polling mode.
 *
 * Spawned by `.switch login` immediately. It:
 *   1. Reads pendingLogin from ~/.telebox-switch/state.json
 *   2. Creates a temporary gramjs TelegramClient (empty StringSession)
 *   3. Calls client.start() which triggers auth.sendCode → Telegram sends code
 *   4. The phoneCode callback POLLS ~/.telebox-switch/secrets/ until a code arrives
 *   5. signIn completes → saves StringSession to ~/.telebox-switch/sessions/
 *   6. Updates state.sessions.teleproto to external → exits
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import {
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
} from "./versionSwitchState";
import path from "path";
import fs from "fs";

const SECRETS_DIR = path.join(DEFAULT_SWITCH_HOME, "secrets");
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 5 * 60_000;

async function pollForSecret(kind: string): Promise<string> {
  const deadline = Date.now() + MAX_POLL_MS;
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    if (!fs.existsSync(SECRETS_DIR)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const files = fs.readdirSync(SECRETS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      const fullPath = path.join(SECRETS_DIR, file);
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw) as { expiresAt?: number; value?: string };
        if (!parsed.value || typeof parsed.expiresAt !== "number") continue;
        if (parsed.expiresAt < Date.now()) {
          fs.rmSync(fullPath, { force: true });
          continue;
        }
        const value = parsed.value;
        fs.rmSync(fullPath, { force: true });
        console.error(`[switch:teleproto] Consumed ${kind} secret from ${file}`);
        return value;
      } catch {
        continue;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${kind} (${MAX_POLL_MS / 1000}s)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function loginForSwitch(): Promise<void> {
  const state = loadSwitchState(DEFAULT_SWITCH_HOME);
  const pending = state.pendingLogin;

  if (!pending) throw new Error("No pending login in switch state");
  if (pending.target !== "teleproto") {
    throw new Error(`Pending login targets ${pending.target}, but this is the teleproto helper`);
  }
  if (pending.expiresAt < Date.now()) throw new Error("Pending login has expired");

  const phone = pending.phone;
  console.error(`[switch:teleproto] Starting login for ${phone} → target teleproto`);

  const api = await getApiConfig();
  if (!api.api_id || !api.api_hash) throw new Error("Missing api_id / api_hash");

  const sessionDir = path.join(DEFAULT_SWITCH_HOME, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const client = new TelegramClient(
    new StringSession(""),
    api.api_id,
    api.api_hash,
    {
      connectionRetries: 3,
      deviceModel: readAppName(),
      proxy: api.proxy,
    },
  );

  try {
    console.error("[switch:teleproto] Connecting and requesting auth code (auth.sendCode)...");
    const me = await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => pollForSecret("code"),
      password: async () => {
        console.error("[switch:teleproto] 2FA requested, polling for password...");
        return pollForSecret("password");
      },
      onError: (err: Error) => {
        console.error("[switch:teleproto] Login error:", err.message);
      },
    });

    // gramjs stores the session in client.session after successful auth
    const sessionStr = String(client.session.save());
    const sessionFile = path.join(sessionDir, "teleproto.session");
    fs.writeFileSync(sessionFile, sessionStr, { mode: 0o600 });
    console.error(`[switch:teleproto] Session saved to ${sessionFile}`);

    const userId = me && typeof me === "object" && "id" in me ? String((me as { id: unknown }).id) : undefined;
    if (!userId) throw new Error("Login succeeded but user ID is missing");
    if (userId !== pending.expectedUserId) {
      throw new Error(`Identity mismatch: expected ${pending.expectedUserId}, got ${userId}`);
    }

    console.error(`[switch:teleproto] ✅ Logged in as user ${userId}`);

    const updated = loadSwitchState(DEFAULT_SWITCH_HOME);
    updated.sessions.teleproto = { kind: "external", path: sessionFile, userId };
    updated.pendingLogin = null;
    updated.stagedSecrets = {};
    saveSwitchState(updated, DEFAULT_SWITCH_HOME);
    console.error(`[switch:teleproto] ✅ External session registered. Ready for .switch go.`);
  } catch (err) {
    console.error("[switch:teleproto] Login failed:", (err as Error).message);
    try {
      const failState = loadSwitchState(DEFAULT_SWITCH_HOME);
      failState.pendingLogin = null;
      failState.stagedSecrets = {};
      saveSwitchState(failState, DEFAULT_SWITCH_HOME);
    } catch { /* ok */ }
    process.exit(1);
  } finally {
    try { await client.disconnect(); } catch { /* ok */ }
  }
}

loginForSwitch().catch((err: Error) => {
  console.error("[switch:teleproto] Fatal:", err.message);
  process.exit(1);
});
