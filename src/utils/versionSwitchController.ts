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
 *   2. Offline session convert (teleproto StringSession ↔ mtcute SQLite)
 *      via versionSwitchSessionConvert.ts — NO re-login / SMS.
 *   3. stop source PM2 → migrate plugins/data → start target PM2 →
 *      wait for ready → rollback on failure.
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
  type PluginIndexEntry,
} from "./versionSwitchCore";
import {
  installMatchedPlugins,
  restoreInstalledPlugins,
  executePluginDataMigration,
  restorePluginDataMigration,
  archiveUnmatchedPlugins,
  type InstalledPluginJournal,
  type PluginDataJournal,
} from "./versionSwitchFs";
import { execSync, spawnSync } from "child_process";
import {
  resolveRepoRoots,
  resolvePluginIndexPath,
  spawnTsxSync,
  ensureNestedLayout,
  completePendingNest,
  pm2StartEdition,
  PEER_DIR_NAME,
} from "./versionSwitchPaths";
import fs from "fs";
import path from "path";

// ─── Config ────────────────────────────────────────────────────────────────

// Nested layout under original runtime home (telebox-classic / telebox-next).
let REPO_ROOTS = resolveRepoRoots();
const NESTED = ensureNestedLayout();
REPO_ROOTS = NESTED.roots;
const PLUGIN_INDEX_PATHS: Record<"teleproto" | "mtcute", string> = {
  teleproto: resolvePluginIndexPath("teleproto"),
  mtcute: resolvePluginIndexPath("mtcute"),
};

const PM2_NAMES: Record<"teleproto" | "mtcute", string> = {
  teleproto: "telebox",
  mtcute: "telebox-next",
};

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 2_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

function getPm2Process(name: string): { name: string; pid: number; pm2_env?: { status: string } } | undefined {
  try {
    const out = execSync("pm2 jlist", { encoding: "utf8", timeout: 10_000 });
    const list: Array<{ name: string; pid: number; pm2_env?: { status: string } }> = JSON.parse(out);
    return list.find((p) => p.name === name);
  } catch {
    return undefined;
  }
}

function runPm2(args: string[], label: string, allowMissing = false): void {
  const result = spawnSync("pm2", args, {
    stdio: "pipe",
    timeout: 30_000,
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.status !== 0) {
    if (allowMissing && /not found|doesn't exist|process or namespace not found/i.test(output)) {
      console.log(`[controller] pm2 ${label}: process missing, treated as OK`);
      return;
    }
    throw new Error(`pm2 ${label} failed: ${output}`);
  }
  console.log(`[controller] pm2 ${label} OK`);
}

function pm2Stop(name: string): void {
  if (!getPm2Process(name)) {
    console.log(`[controller] pm2 stop ${name}: process missing, treated as OK`);
    return;
  }
  runPm2(["stop", name], `stop ${name}`);
}

function pm2StartVersion(version: "teleproto" | "mtcute"): void {
  // Always --cwd = edition subdir under runtime home (not the home itself).
  const repo = REPO_ROOTS[version];
  console.log(`[controller] PM2 start ${version} cwd=${repo} (${PEER_DIR_NAME[version]})`);
  pm2StartEdition(version, repo, runPm2, getPm2Process);
}

function pm2(action: "stop" | "start" | "restart", name: string): void {
  const version = (Object.entries(PM2_NAMES) as Array<["teleproto" | "mtcute", string]>).find(([, pm2Name]) => pm2Name === name)?.[0];

  if (action === "stop") {
    pm2Stop(name);
    return;
  }

  if (action === "start" && version) {
    pm2StartVersion(version);
    return;
  }

  if (action === "restart" && version) {
    pm2Stop(name);
    pm2StartVersion(version);
    return;
  }

  runPm2([action, name], `${action} ${name}`);
}

function isPm2Online(name: string): boolean {
  const proc = getPm2Process(name);
  return proc?.pm2_env?.status === "online" && proc.pid > 0;
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


function listTargetNativePluginNames(pluginRepo: string): string[] {
  if (!fs.existsSync(pluginRepo)) return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(pluginRepo, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "outdated" || entry.name === "scripts" || entry.name.startsWith(".")) continue;
    const impl = path.join(pluginRepo, entry.name, `${entry.name}.ts`);
    if (fs.existsSync(impl)) names.push(entry.name);
  }
  return names;
}

function runSessionConvert(source: "teleproto" | "mtcute", target: "teleproto" | "mtcute"): void {
  // Always run conversion under mtcute repo (has @mtcute/convert).
  // Use process.execPath + scripts/run-tsx.cjs — never bare "npx" (PATH may be empty under PM2).
  const script = path.join(REPO_ROOTS.mtcute, "src", "utils", "versionSwitchSessionConvert.ts");
  console.log(`[controller] Converting session ${source} → ${target} via ${script}`);
  const result = spawnTsxSync(REPO_ROOTS.mtcute, script, {
    cwd: REPO_ROOTS.mtcute,
    stdio: "inherit",
    timeout: 120_000,
    env: {
      ...process.env,
      SWITCH_SOURCE: source,
      SWITCH_TARGET: target,
      SWITCH_HOME: DEFAULT_SWITCH_HOME,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Session convert ${source}→${target} failed with status ${result.status}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const state = loadSwitchState(DEFAULT_SWITCH_HOME);
  const skipLogin = process.env.SWITCH_SKIP_LOGIN === "1";
  const envSource = process.env.SWITCH_SOURCE as "teleproto" | "mtcute" | undefined;
  const envTarget = process.env.SWITCH_TARGET as "teleproto" | "mtcute" | undefined;

  let source: "teleproto" | "mtcute";
  let target: "teleproto" | "mtcute";
  let extPath: string;

  if (skipLogin && envSource && envTarget) {
    // Fast path: session already exists (native or external)
    source = envSource;
    target = envTarget;
    console.log(`[controller] Fast-path switching ${source} → ${target}`);

    const targetSession = state.sessions[target];
    extPath = resolveExternalSessionPath(target, DEFAULT_SWITCH_HOME) ?? "";
    if (targetSession.kind === "native") {
      // Native session — the session lives in the target repo already, no injection needed
      extPath = "";
      console.log(`[controller] Target ${target} has native session — no injection needed`);
    } else if (!extPath) {
      throw new Error("SWITCH_SKIP_LOGIN set but no session registered for " + target);
    } else {
      console.log(`[controller] Using existing external session: ${extPath}`);
    }
  } else if (envSource && envTarget) {
    // Convert path: offline session conversion (no re-login / no SMS)
    source = envSource;
    target = envTarget;
    console.log(`[controller] Converting session then switching ${source} → ${target}`);

    console.log("[controller] Step 1: Converting session offline...");
    try {
      runSessionConvert(source, target);
    } catch (err) {
      console.error("[controller] Session convert failed:", err);
      state.pendingTransaction = null;
      state.pendingLogin = null;
      state.stagedSecrets = {};
      saveSwitchState(state, DEFAULT_SWITCH_HOME);
      process.exit(1);
    }

    extPath = resolveExternalSessionPath(target, DEFAULT_SWITCH_HOME) ?? "";
    if (!extPath) {
      throw new Error("Session convert succeeded but external session path is missing");
    }
    console.log(`[controller] Converted session ready: ${extPath}`);
  } else {
    throw new Error(
      "Controller requires SWITCH_SOURCE + SWITCH_TARGET (session convert). " +
      "Re-login helpers are no longer used.",
    );
  }

  // ── Step 2: Match and install plugins ────────────────────────────────
  console.log("[controller] Step 2: Matching plugins...");
  const sourceIndex = loadPluginIndex(source);
  const targetIndex = loadPluginIndex(target);
  const sourceInstalled = listInstalledPlugins(source);
  const targetPluginRepo = PLUGIN_INDEX_PATHS[target].replace(/\/plugins\.json$/, "");
  const targetAvailable = listTargetNativePluginNames(targetPluginRepo);
  const { install, unavailable } = matchPlugins(
    sourceInstalled,
    sourceIndex,
    targetIndex,
    targetAvailable,
  );

  const txId = state.pendingTransaction ?? String(Date.now());
  const backupRoot = path.join(DEFAULT_SWITCH_HOME, "backups", txId);
  const archiveRoot = path.join(DEFAULT_SWITCH_HOME, "archives", `${source}-to-${target}`, txId);
  let pluginJournal: InstalledPluginJournal | null = null;
  let dataJournal: PluginDataJournal | null = null;
  let archivedCount = 0;

  console.log(
    `[controller] Plugins: ${install.length} install, ${unavailable.length} unavailable (archive)`,
  );

  try {
    // Archive plugins that have no counterpart on the target version
    // (source file + assets/<plugin>/ configs) so nothing is silently lost.
    if (unavailable.length > 0) {
      console.log(`[controller] Archiving ${unavailable.length} unmatched plugins → ${archiveRoot}`);
      const report = archiveUnmatchedPlugins({
        names: unavailable,
        sourceVersion: source,
        targetVersion: target,
        sourcePluginsDir: path.join(REPO_ROOTS[source], "plugins"),
        sourceAssetsRoot: path.join(REPO_ROOTS[source], "assets"),
        archiveRoot,
      });
      archivedCount = report.entries.length;
      console.log(`[controller] Archived ${archivedCount} plugins (see ${archiveRoot}/manifest.json)`);
    }

    if (install.length > 0) {
      pluginJournal = await installMatchedPlugins({
        matches: install,
        targetPluginRepo,
        targetPluginsDir: path.join(REPO_ROOTS[target], "plugins"),
        backupRoot: path.join(backupRoot, "plugins"),
      });
    }

    // ── Step 3: Migrate plugin data / configs for ALL installed plugins ──
    // Always attempt assets migration for matched plugins so configs aren't dropped
    // even when the target already had a plugin file.
    console.log("[controller] Step 3: Migrating plugin data/configs...");
    const migrateNames = install.map((m) => m.name);
    if (migrateNames.length > 0) {
      dataJournal = executePluginDataMigration({
        plugins: migrateNames,
        sourceAssetsRoot: path.join(REPO_ROOTS[source], "assets"),
        targetAssetsRoot: path.join(REPO_ROOTS[target], "assets"),
        backupRoot: path.join(backupRoot, "assets"),
      });
      console.log(
        `[controller] Migrated configs for ${dataJournal.entries.length} plugins with assets`,
      );
    }

    // ── Step 4: Mark state and stop source ─────────────────────────────
    console.log("[controller] Step 4: Marking state and stopping source...");
    const preSwitchState = loadSwitchState(DEFAULT_SWITCH_HOME);
    preSwitchState.activeVersion = target;
    preSwitchState.pendingTransaction = null;
    // Attach migration summary for the post-switch notification
    if (preSwitchState.pendingNotification) {
      const lines = [
        `插件：已同步 ${install.length} 个`,
        archivedCount > 0
          ? `仅当前版本有的插件：已保存 ${archivedCount} 个 → ~/.telebox-switch/archives/`
          : "仅当前版本有的插件：无",
        "配置：已把 assets 里的插件配置合并到目标版本",
      ];
      preSwitchState.pendingNotification = {
        ...preSwitchState.pendingNotification,
        summary: lines.join("\n"),
      };
    }
    saveSwitchState(preSwitchState, DEFAULT_SWITCH_HOME);

    // Inject external session into target version's config (only if external).
    // Re-read state: convert path updates sessions[target] on disk after `state` was loaded.
    const latestState = loadSwitchState(DEFAULT_SWITCH_HOME);
    const targetSession = latestState.sessions[target];
    if (targetSession.kind === "external" && (extPath || targetSession.path)) {
      injectSessionConfig(target, extPath || targetSession.path);
    } else {
      console.log(`[controller] Target ${target} uses native session — skipping injection`);
      if (target === "mtcute") clearSwitchSessionMarker(target);
    }

    pm2("stop", PM2_NAMES[source]);
    console.log(`[controller] Stopped ${source} (${PM2_NAMES[source]})`);

    // Flatten → nested: move live edition into home/telebox-xx after process stopped
    const nestState = ensureNestedLayout();
    if (nestState.pendingNest) {
      console.log(
        `[controller] Nesting flat install into ${PEER_DIR_NAME[nestState.pendingNest.version]}…`,
      );
      completePendingNest(nestState.pendingNest, nestState.home);
      REPO_ROOTS = resolveRepoRoots();
      console.log(
        `[controller] Nested layout ready: teleproto=${REPO_ROOTS.teleproto} mtcute=${REPO_ROOTS.mtcute}`,
      );
      // Re-inject session into (possibly moved) target path
      const afterNest = loadSwitchState(DEFAULT_SWITCH_HOME);
      const sess = afterNest.sessions[target];
      if (sess.kind === "external" && sess.path) {
        injectSessionConfig(target, sess.path);
      }
    } else {
      REPO_ROOTS = resolveRepoRoots();
    }

    // ── Step 5: Start target (PM2 --cwd = nested edition dir) ─────────
    console.log("[controller] Step 5: Starting target...");
    // Drop any leftover process still pointing at flat home
    for (const name of Object.values(PM2_NAMES)) {
      const proc = getPm2Process(name);
      if (proc) {
        /* start path deletes+recreates target; source already stopped */
      }
    }
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

function clearSwitchSessionMarker(version: "teleproto" | "mtcute"): void {
  const configPath = path.join(REPO_ROOTS[version], "config.json");
  if (!fs.existsSync(configPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if ("_switchSessionPath" in config) {
      delete config._switchSessionPath;
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  } catch { /* ignore */ }
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
