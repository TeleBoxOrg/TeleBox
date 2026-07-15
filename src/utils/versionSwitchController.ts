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
  prepareEdition,
  PEER_DIR_NAME,
  isRunnableRepo,
} from "./versionSwitchPaths";
import {
  SwitchProgressReporter,
  markSwitchInProgress,
  clearSwitchInProgress,
} from "./versionSwitchProgress";
import fs from "fs";
import path from "path";

// ─── Config ────────────────────────────────────────────────────────────────

// Nested layout under original runtime home (telebox-classic / telebox-next).
let REPO_ROOTS = resolveRepoRoots({ prepareMissing: false });
const NESTED = ensureNestedLayout({ prepareMissing: false });
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
    const dir = path.join(pluginRepo, entry.name);
    const impl = path.join(dir, `${entry.name}.ts`);
    // Standard plugin package: <name>/<name>.ts
    if (fs.existsSync(impl)) {
      names.push(entry.name);
      continue;
    }
    // Companion / helper package: directory with any .ts (e.g. sanitizeFileName)
    // used by multi-file plugins; must be migratable even without plugins.json entry.
    try {
      const hasTs = fs.readdirSync(dir).some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      if (hasTs) names.push(entry.name);
    } catch { /* ignore */ }
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
  let progress: SwitchProgressReporter | null = null;

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
    extPath = "";
  } else {
    throw new Error(
      "Controller requires SWITCH_SOURCE + SWITCH_TARGET (session convert). " +
      "Re-login helpers are no longer used.",
    );
  }

  // Live progress on the original .switch go message (works after PM2 stop)
  progress = new SwitchProgressReporter(source, target);
  markSwitchInProgress({ source, target, reason: "controller" });
  await progress.init();
  await progress.set("layout", "running", `准备 ${PEER_DIR_NAME[target]}…`);

  // Prepare target edition (clone + npm install) — may take minutes first time
  try {
    const targetRoot = prepareEdition(target);
    REPO_ROOTS = { ...REPO_ROOTS, [target]: targetRoot };
    // Seed config.json onto fresh clones ASAP (api_id/hash from source) — zero-config
    try {
      ensureEditionConfig(target, source);
    } catch (e) {
      console.warn("[controller] early config seed deferred:", e);
    }
    // Source must remain resolvable
    try {
      const srcRoot = prepareEdition(source);
      REPO_ROOTS = { ...REPO_ROOTS, [source]: srcRoot };
    } catch (e) {
      // Source is current running install — resolve without full prepare
      REPO_ROOTS = resolveRepoRoots({ prepareMissing: false });
      REPO_ROOTS[target] = targetRoot;
    }
    if (!isRunnableRepo(REPO_ROOTS[target], target)) {
      throw new Error(`目标版本未就绪: ${REPO_ROOTS[target]}`);
    }
    await progress.set("layout", "done", PEER_DIR_NAME[target]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[controller] prepare target failed:", err);
    await progress.fail(msg);
    await progress.close();
    process.exit(1);
  }

  // ── Step 1: Session convert (unless skip) ──────────────────────────
  if (skipLogin) {
    await progress.set("convert", "skip", "已有 session");
  } else {
    await progress.set("convert", "running");
    console.log("[controller] Step 1: Converting session offline...");
    try {
      runSessionConvert(source, target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[controller] Session convert failed:", err);
      await progress.fail(msg);
      state.pendingTransaction = null;
      state.pendingLogin = null;
      state.stagedSecrets = {};
      saveSwitchState(state, DEFAULT_SWITCH_HOME);
      await progress.close();
      process.exit(1);
    }
    extPath = resolveExternalSessionPath(target, DEFAULT_SWITCH_HOME) ?? "";
    if (!extPath) {
      await progress.fail("Session convert succeeded but external session path is missing");
      await progress.close();
      throw new Error("Session convert succeeded but external session path is missing");
    }
    console.log(`[controller] Converted session ready: ${extPath}`);
    await progress.set("convert", "done");
  }

  // ── Step 2: Match and install plugins ────────────────────────────────
  console.log("[controller] Step 2: Matching plugins...");
  await progress.set("plugins", "running");
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
  await progress.set(
    "plugins",
    install.length > 0 ? "running" : "done",
    install.length > 0 ? `安装 ${install.length} 个` : "无需安装",
  );

  try {
    // Archive plugins that have no counterpart on the target version
    // (source file + assets/<plugin>/ configs) so nothing is silently lost.
    if (unavailable.length > 0) {
      await progress.set("archive", "running", `${unavailable.length} 个`);
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
      await progress.set("archive", "done", `已保存 ${archivedCount} 个`);
    } else {
      await progress.set("archive", "skip", "无");
    }

    if (install.length > 0) {
      await progress.set("plugins", "running", `安装 ${install.length} 个…`);
      pluginJournal = await installMatchedPlugins({
        matches: install,
        targetPluginRepo,
        targetPluginsDir: path.join(REPO_ROOTS[target], "plugins"),
        backupRoot: path.join(backupRoot, "plugins"),
      });
    }

    await progress.set(
      "plugins",
      "done",
      install.length > 0 ? `已同步 ${install.length} 个` : "无需安装",
    );

    // ── Step 3: Migrate plugin data / configs for ALL installed plugins ──
    // Always attempt assets migration for matched plugins so configs aren't dropped
    // even when the target already had a plugin file.
    console.log("[controller] Step 3: Migrating plugin data/configs...");
    await progress.set("configs", "running");
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
      await progress.set("configs", "done", `${dataJournal.entries.length} 项`);
    } else {
      await progress.set("configs", "skip", "无配置可合并");
    }

    // ── Step 4: Mark state and stop source ─────────────────────────────
    console.log("[controller] Step 4: Marking state and stopping source...");
    await progress.set("stop", "running", "即将离线…");
    const preSwitchState = loadSwitchState(DEFAULT_SWITCH_HOME);
    preSwitchState.activeVersion = target;
    preSwitchState.pendingTransaction = null;
    // Attach migration summary for the post-switch notification
    if (preSwitchState.pendingNotification) {
      // Final summary (paths + unmatched plugin names) is written after nest.
      preSwitchState.pendingNotification = {
        ...preSwitchState.pendingNotification,
        summary: `插件：已同步 ${install.length} 个（详情见完成后的结果）`,
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

    // Critical: we are about to stop the source bot. This controller MUST already
    // be outside the bot's process tree (spawned via setsid). Write a heartbeat
    // so operators can see we reached pre-stop even if the next log never flushes.
    console.log(
      `[controller] Pre-stop checkpoint: source=${PM2_NAMES[source]} target=${PM2_NAMES[target]} pid=${process.pid}`,
    );
    try {
      fs.writeFileSync(
        path.join(DEFAULT_SWITCH_HOME, "controller.alive"),
        JSON.stringify({ pid: process.pid, at: Date.now(), phase: "pre-stop" }),
        { mode: 0o600 },
      );
    } catch { /* ignore */ }

    // Prefer delete+recreate later for target; for source use stop.
    // Note: `pm2 stop` with kill_tree will kill children of the bot — controller
    // must not be a child (see spawnTsxDetached setsid).
    pm2("stop", PM2_NAMES[source]);
    console.log(`[controller] Stopped ${source} (${PM2_NAMES[source]})`);
    try {
      fs.writeFileSync(
        path.join(DEFAULT_SWITCH_HOME, "controller.alive"),
        JSON.stringify({ pid: process.pid, at: Date.now(), phase: "post-stop" }),
        { mode: 0o600 },
      );
    } catch { /* ignore */ }
    await progress.set("stop", "done", "源 bot 已离线，后续由目标版完成通知");

    // Flatten → nested: move live edition into home/telebox-xx after process stopped
    const nestState = ensureNestedLayout();
    if (nestState.pendingNest) {
      await progress.set("nest", "running");
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
      await progress.set("nest", "done");
    } else {
      REPO_ROOTS = resolveRepoRoots();
      await progress.set("nest", "skip", "已是嵌套布局");
    }

    // ── Step 5: Start target (PM2 --cwd = nested edition dir) ─────────
    console.log("[controller] Step 5: Starting target...");
    await progress.set("start", "running", PM2_NAMES[target]);
    // Drop any leftover process still pointing at flat home
    for (const name of Object.values(PM2_NAMES)) {
      const proc = getPm2Process(name);
      if (proc) {
        /* start path deletes+recreates target; source already stopped */
      }
    }
    pm2("start", PM2_NAMES[target]);

    await progress.set("start", "done");

    // ── Step 6: Wait for ready ─────────────────────────────────────────
    console.log("[controller] Step 6: Waiting for target to come online...");
    await progress.set("ready", "running", "等待上线…");
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
    await progress.set("ready", "done", "已上线");

    // Final user-facing summary: unmatched plugins + edition directories (post-nest)
    try {
      const finalState = loadSwitchState(DEFAULT_SWITCH_HOME);
      if (finalState.pendingNotification) {
        const sourceLabel = source === "teleproto" ? "TeleBox" : "TeleBox-Next";
        const targetLabel = target === "teleproto" ? "TeleBox" : "TeleBox-Next";
        const maxList = 40;
        let unmatchedBlock: string;
        if (unavailable.length === 0) {
          unmatchedBlock = "无（全部已匹配迁移）";
        } else {
          const shown = unavailable.slice(0, maxList);
          const more =
            unavailable.length > maxList
              ? `\n…另有 ${unavailable.length - maxList} 个`
              : "";
          unmatchedBlock =
            shown.map((n) => `• ${n}`).join("\n") + more;
        }
        const lines = [
          "—— 切换结果 ——",
          "",
          "1) 未迁移成功的插件（目标版无对应项，已归档）：",
          unmatchedBlock,
          archivedCount > 0 ? `归档目录：${archiveRoot}` : "",
          "",
          `2) 原版本（${sourceLabel}）目录：`,
          REPO_ROOTS[source],
          "",
          `3) 现在运行（${targetLabel}）目录：`,
          REPO_ROOTS[target],
          "",
          `插件已同步：${install.length} 个`,
        ].filter((line) => line !== "");
        finalState.pendingNotification = {
          ...finalState.pendingNotification,
          summary: lines.join("\n"),
        };
        saveSwitchState(finalState, DEFAULT_SWITCH_HOME);
        console.log("[controller] Wrote final switch summary for notification");
      }
    } catch (e) {
      console.warn("[controller] Failed to write final switch summary:", e);
    }

    await progress.done("目标版本已上线，正在完成最终通知…");
    clearSwitchInProgress();
    await progress.close();
  } catch (err) {
    console.error("[controller] Switch failed, rolling back...", err);
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await progress?.fail(msg);
    } catch { /* ignore */ }

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

    try {
      await progress?.close();
    } catch { /* ignore */ }
    clearSwitchInProgress();
    process.exit(1);
  }
}

/**
 * Fresh clones under runtime home (e.g. telebox/telebox-next) have no config.json.
 * Zero-config switch: seed api_id/api_hash (and optional proxy) from the source
 * edition or any known sibling install so the user never hand-copies credentials.
 */
function readJsonConfig(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findSeedConfig(preferVersion?: "teleproto" | "mtcute"): Record<string, unknown> | null {
  const candidates: string[] = [];
  if (preferVersion) {
    candidates.push(path.join(REPO_ROOTS[preferVersion], "config.json"));
  }
  for (const root of Object.values(REPO_ROOTS)) {
    candidates.push(path.join(root, "config.json"));
  }
  // Standalone / legacy locations (before nest)
  const home = path.dirname(REPO_ROOTS.teleproto) === path.dirname(REPO_ROOTS.mtcute)
    ? path.dirname(REPO_ROOTS.teleproto)
    : process.env.HOME || "/root";
  candidates.push(
    path.join(home, "telebox", "config.json"),
    path.join(home, "telebox-next", "config.json"),
    path.join(home, "telebox-classic", "config.json"),
    path.join(home, "telebox_mtcute", "config.json"),
    path.join("/root/telebox/config.json"),
    path.join("/root/telebox-next/config.json"),
  );

  const seen = new Set<string>();
  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const cfg = readJsonConfig(resolved);
    if (!cfg) continue;
    const apiId = cfg.api_id ?? cfg.apiId;
    const apiHash = cfg.api_hash ?? cfg.apiHash;
    if (apiId != null && apiHash) {
      console.log(`[controller] Seed config from ${resolved}`);
      return cfg;
    }
  }
  return null;
}

/** Ensure target edition has a usable config.json (create from source if missing). */
function ensureEditionConfig(
  version: "teleproto" | "mtcute",
  seedFrom?: "teleproto" | "mtcute",
): string {
  const repo = REPO_ROOTS[version];
  if (!repo || !fs.existsSync(repo)) {
    throw new Error(`目标版本目录不存在: ${repo || version}`);
  }
  const configPath = path.join(repo, "config.json");
  const existing = readJsonConfig(configPath);
  if (existing && (existing.api_id != null || existing.apiId != null) && (existing.api_hash || existing.apiHash)) {
    return configPath;
  }

  const seed = findSeedConfig(seedFrom ?? (version === "mtcute" ? "teleproto" : "mtcute"));
  if (!seed) {
    throw new Error(
      `目标版本缺少 config.json，且无法从当前版本自动生成凭证。\n` +
        `请确认当前运行中的 TeleBox 目录里有 config.json（含 api_id / api_hash）。\n` +
        `目标路径: ${configPath}`,
    );
  }

  const next: Record<string, unknown> = {
    api_id: seed.api_id ?? seed.apiId,
    api_hash: seed.api_hash ?? seed.apiHash,
  };
  // Optional fields users may have customized
  for (const key of ["proxy", "device_model", "system_version", "app_version", "lang_code", "system_lang_code"]) {
    if (seed[key] != null) next[key] = seed[key];
  }
  // Keep existing session markers if any partial file existed
  if (existing?.session) next.session = existing.session;
  if (existing?._switchSessionPath) next._switchSessionPath = existing._switchSessionPath;

  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[controller] Wrote ${configPath} (auto-seeded api credentials for zero-config switch)`);
  return configPath;
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
  // Fresh nested clones never ship config.json — seed from the other edition first.
  const configPath = ensureEditionConfig(
    version,
    version === "mtcute" ? "teleproto" : "mtcute",
  );

  if (version === "teleproto") {
    // gramjs: config.json.session is the StringSession string
    const sessionStr = fs.readFileSync(extPath, "utf8").trim();
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.session = sessionStr;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`[controller] Injected teleproto session into ${configPath}`);
  } else {
    // mtcute: external SQLite path via _switchSessionPath (see mtcuteClient.ts)
    if (!fs.existsSync(extPath)) {
      throw new Error(`外部 session 文件不存在: ${extPath}`);
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config._switchSessionPath = extPath;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`[controller] Injected mtcute session marker → ${extPath}`);
  }
}

main().catch((err) => {
  console.error("[controller] Fatal:", err);
  try { clearSwitchInProgress(); } catch { /* ignore */ }
  process.exit(1);
});
