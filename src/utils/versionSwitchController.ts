#!/usr/bin/env node
/**
 * Standalone version-switch controller.
 *
 * Orchestrates a TeleBox version switch (teleproto ↔ mtcute). It is spawned
 * as a detached child process by the versionSwitch plugin so that the switch
 * survives a PM2 restart of the source bot.
 *
 * Flow:
 *   1. Read ~/.telebox-switch/state.json (created by the source plugin).
 *   2. Run the target version's login helper (consumes staged secrets).
 *   3. If login succeeds: stop source PM2 → migrate plugins/data →
 *      start target PM2 → wait for ready → rollback on failure.
 */

import {
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
  resolveExternalSessionPath,
  type VersionSwitchState,
  type SessionSelection,
} from "./versionSwitchState";
import {
  buildCompatibilityReport,
  matchPlugins,
  planPluginDataMigration,
  type PluginIndexEntry,
} from "./versionSwitchCore";
import {
  installMatchedPlugins,
  restoreInstalledPlugins,
  executePluginDataMigration,
  restorePluginDataMigration,
  type InstalledPluginJournal,
  type PluginDataJournal,
} from "./versionSwitchFs";
import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// ─── Config ────────────────────────────────────────────────────────────────

const REPO_ROOTS: Record<"teleproto" | "mtcute", string> = {
  teleproto: "/root/telebox",
  mtcute: "/root/telebox_mtcute",
};

const PM2_NAMES: Record<"teleproto" | "mtcute", string> = {
  teleproto: "telebox",
  mtcute: "telebox-mtcute",
};

const PLUGIN_INDEX_PATHS: Record<"teleproto" | "mtcute", string> = {
  teleproto: "/root/TeleBox_Plugins/plugins.json",
  mtcute: "/root/TeleBox_M_Plugins/plugins.json",
};

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 2_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

function pm2(action: "stop" | "start" | "restart", name: string): void {
  const result = spawnSync("pm2", [action, name], {
    stdio: "pipe",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`pm2 ${action} ${name} failed: ${result.stderr.toString()}`);
  }
  console.log(`[controller] pm2 ${action} ${name} OK`);
}

function isPm2Online(name: string): boolean {
  try {
    const out = execSync(`pm2 jlist`, { encoding: "utf8", timeout: 10_000 });
    const list: Array<{ name: string; pid: number; pm2_env?: { status: string } }> =
      JSON.parse(out);
    const proc = list.find((p) => p.name === name);
    return proc?.pm2_env?.status === "online" && proc.pid > 0;
  } catch {
    return false;
  }
}

function loadPluginIndex(version: "teleproto" | "mtcute"): Record<string, PluginIndexEntry> {
  const raw = fs.readFileSync(PLUGIN_INDEX_PATHS[version], "utf8");
  return JSON.parse(raw) as Record<string, PluginIndexEntry>;
}

function listInstalledPlugins(version: "teleproto" | "mtcute"): string[] {
  const dir = path.join(REPO_ROOTS[version], "plugins");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
}

function runLoginHelper(version: "teleproto" | "mtcute"): void {
  const repo = REPO_ROOTS[version];
  const script = path.join(repo, "src", "utils", "versionSwitchLogin.ts");
  console.log(`[controller] Running login helper: ${script}`);
  const result = spawnSync(
    "npx",
    ["tsx", script],
    { cwd: repo, stdio: "inherit", timeout: 120_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Login helper for ${version} failed with status ${result.status}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const state = loadSwitchState(DEFAULT_SWITCH_HOME);
  const txId = state.pendingTransaction;
  if (!txId) {
    console.log("[controller] No pending transaction — nothing to do.");
    return;
  }

  // Determine direction from pendingLogin target (set by .switch login / .switch go)
  const pendingLogin = state.pendingLogin;
  if (!pendingLogin) {
    throw new Error("Pending transaction without pending login");
  }

  const source: "teleproto" | "mtcute" =
    pendingLogin.target === "teleproto" ? "mtcute" : "teleproto";
  const target = pendingLogin.target;
  console.log(`[controller] Switching ${source} → ${target} (tx=${txId})`);

  // ── Step 1: Login to target version ──────────────────────────────────
  console.log("[controller] Step 1: Logging in to target version...");
  try {
    runLoginHelper(target);
  } catch (err) {
    console.error("[controller] Login failed:", err);
    state.pendingTransaction = null;
    state.pendingLogin = null;
    state.stagedSecrets = {};
    saveSwitchState(state, DEFAULT_SWITCH_HOME);
    process.exit(1);
  }

  // Verify external session is now ready
  const reloaded = loadSwitchState(DEFAULT_SWITCH_HOME);
  const extPath = resolveExternalSessionPath(target, DEFAULT_SWITCH_HOME);
  if (!extPath) {
    throw new Error("Login succeeded but external session path is missing");
  }
  console.log(`[controller] External session ready: ${extPath}`);

  // ── Step 2: Match and install plugins ────────────────────────────────
  console.log("[controller] Step 2: Matching plugins...");
  const sourceIndex = loadPluginIndex(source);
  const targetIndex = loadPluginIndex(target);
  const sourceInstalled = listInstalledPlugins(source);
  const { install } = matchPlugins(sourceInstalled, sourceIndex, targetIndex);

  console.log(`[controller] Installing ${install.length} matched plugins to ${target}...`);
  const backupRoot = path.join(DEFAULT_SWITCH_HOME, "backups", txId);
  let pluginJournal: InstalledPluginJournal | null = null;
  let dataJournal: PluginDataJournal | null = null;

  try {
    if (install.length > 0) {
      pluginJournal = await installMatchedPlugins({
        matches: install,
        targetPluginRepo: PLUGIN_INDEX_PATHS[target].replace(
          /\/plugins\.json$/,
          "",
        ),
        targetPluginsDir: path.join(REPO_ROOTS[target], "plugins"),
        backupRoot: path.join(backupRoot, "plugins"),
      });

      // ── Step 3: Migrate plugin data ──────────────────────────────────
      console.log("[controller] Step 3: Migrating plugin data...");
      const stepPlan = planPluginDataMigration({
        plugins: install.map((m) => m.name),
        sourceAssetsRoot: path.join(REPO_ROOTS[source], "assets"),
        targetAssetsRoot: path.join(REPO_ROOTS[target], "assets"),
        backupRoot: path.join(backupRoot, "assets"),
      });

      if (stepPlan.length > 0) {
        const pluginNames = [...new Set(stepPlan.map((s) => s.plugin))];
        dataJournal = executePluginDataMigration({
          plugins: pluginNames,
          sourceAssetsRoot: path.join(REPO_ROOTS[source], "assets"),
          targetAssetsRoot: path.join(REPO_ROOTS[target], "assets"),
          backupRoot: path.join(backupRoot, "assets"),
        });
      }
    }

    // ── Step 4: Mark state and stop source ─────────────────────────────
    console.log("[controller] Step 4: Marking state and stopping source...");
    const preSwitchState = loadSwitchState(DEFAULT_SWITCH_HOME);
    preSwitchState.activeVersion = target;
    preSwitchState.pendingTransaction = null;
    saveSwitchState(preSwitchState, DEFAULT_SWITCH_HOME);

    // Inject external session into target version's config
    injectSessionConfig(target, extPath);

    pm2("stop", PM2_NAMES[source]);
    console.log(`[controller] Stopped ${source} (${PM2_NAMES[source]})`);

    // ── Step 5: Start target ───────────────────────────────────────────
    console.log("[controller] Step 5: Starting target...");
    pm2("start", PM2_NAMES[target]);

    // ── Step 6: Wait for ready ─────────────────────────────────────────
    console.log("[controller] Step 6: Waiting for target to come online...");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (isPm2Online(PM2_NAMES[target])) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }

    if (!ready) {
      throw new Error(`Target ${target} did not become ready within ${READY_TIMEOUT_MS}ms`);
    }

    console.log(`[controller] ✅ Switch complete: ${source} → ${target}`);
  } catch (err) {
    console.error("[controller] Switch failed, rolling back...", err);

    // Rollback: restore plugin data, restore plugins, restart source
    try {
      if (dataJournal) restorePluginDataMigration(dataJournal);
      if (pluginJournal) restoreInstalledPlugins(pluginJournal);
    } catch (rollbackErr) {
      console.error("[controller] Rollback (plugins/data) failed:", rollbackErr);
    }

    try {
      pm2("stop", PM2_NAMES[target]);
      pm2("restart", PM2_NAMES[source]);
      console.log("[controller] ✅ Rollback complete, source restarted.");
    } catch (rollbackErr) {
      console.error("[controller] Rollback (PM2) failed:", rollbackErr);
    }

    const failState = loadSwitchState(DEFAULT_SWITCH_HOME);
    failState.activeVersion = source; // stay on source
    failState.pendingTransaction = null;
    failState.pendingLogin = null;
    failState.stagedSecrets = {};
    failState.sessions[target] = { kind: "native" }; // revert to native
    saveSwitchState(failState, DEFAULT_SWITCH_HOME);

    process.exit(1);
  }
}

function injectSessionConfig(version: "teleproto" | "mtcute", extPath: string): void {
  const repo = REPO_ROOTS[version];
  const configPath = path.join(repo, "config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found: ${configPath}`);
  }

  if (version === "teleproto") {
    // gramjs: config.json.session is the StringSession string
    const sessionStr = fs.readFileSync(extPath, "utf8").trim();
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.session = sessionStr;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } else {
    // mtcute: session.db is an SQLite file — we use the external path directly.
    // mtcuteClient.ts reads SESSION_DB_PATH from process.cwd()/session.db.
    // For external sessions, we replace the symlink-or-copy approach:
    // The target repo's runtimeManager reads config.json and creates the client.
    // We write a marker in config.json so the startup path resolver picks it up.
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config._switchSessionPath = extPath;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

main().catch((err) => {
  console.error("[controller] Fatal:", err);
  process.exit(1);
});
