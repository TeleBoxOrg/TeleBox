/**
 * teleproto (gramjs) login helper for version switching.
 *
 * Creates a temporary TelegramClient, logs in using staged secrets from
 * ~/.telebox-switch, and saves the resulting StringSession to the switch
 * sessions directory. Called by the switch controller in a subprocess
 * so that it doesn't interfere with the running bot's client.
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import {
  consumeSecret,
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
  type PendingLogin,
} from "./versionSwitchState";
import path from "path";
import fs from "fs";

async function resolveSecret(statePath: string | undefined): Promise<string | null> {
  if (!statePath) return null;
  return consumeSecret(statePath);
}

export async function loginForSwitch(): Promise<void> {
  const state = loadSwitchState(DEFAULT_SWITCH_HOME);
  const pending: PendingLogin | null = state.pendingLogin;

  if (!pending) {
    throw new Error("No pending login in switch state");
  }
  if (pending.target !== "teleproto") {
    throw new Error(
      `Pending login targets ${pending.target}, but this is the teleproto helper`,
    );
  }
  if (pending.expiresAt < Date.now()) {
    throw new Error("Pending login has expired");
  }

  // Consume staged secrets (read-once, file deleted after read).
  const phone = pending.phone;
  const code = await resolveSecret(state.stagedSecrets.code);
  const password = await resolveSecret(state.stagedSecrets.password);

  if (!code) {
    throw new Error("No verification code staged — wait for the Telegram code and try again");
  }

  const api = await getApiConfig();
  if (!api.api_id || !api.api_hash) {
    throw new Error("Missing api_id / api_hash in config.json");
  }

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

  let me: { id?: unknown };
  try {
    me = await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => code,
      password: password
        ? async () => password
        : undefined,
      onError: (err: Error) => {
        console.error("[switch:teleproto] Login error:", err.message);
      },
    }) as unknown as { id?: unknown };
  } finally {
    // Always disconnect — we only needed the session string.
    try {
      // gramjs stores the session in client.session after successful auth
      const sessionStr = String(client.session.save());
      const sessionFile = path.join(sessionDir, "teleproto.session");
      fs.writeFileSync(sessionFile, sessionStr, { mode: 0o600 });
      console.log(`[switch:teleproto] Session saved to ${sessionFile}`);
    } catch (e) {
      console.error("[switch:teleproto] Failed to save session:", e);
    }
    try {
      await client.disconnect();
    } catch {
      // best effort
    }
  }

  const userId = me?.id ? String(me.id) : undefined;
  if (!userId) {
    throw new Error("Login succeeded but user ID is missing");
  }

  if (userId !== pending.expectedUserId) {
    throw new Error(
      `Identity mismatch: expected ${pending.expectedUserId}, got ${userId}`,
    );
  }

  // Mark this version as having an external session ready.
  const updated = loadSwitchState(DEFAULT_SWITCH_HOME);
  updated.sessions.teleproto = {
    kind: "external",
    path: path.join(sessionDir, "teleproto.session"),
    userId,
  };
  updated.pendingLogin = null;
  updated.stagedSecrets = {};
  saveSwitchState(updated, DEFAULT_SWITCH_HOME);
  console.log(`[switch:teleproto] External session registered for user ${userId}`);
}

// Run directly when executed as a standalone script.
loginForSwitch().catch((err) => {
  console.error("[switch:teleproto] Fatal:", err.message);
  process.exit(1);
});
