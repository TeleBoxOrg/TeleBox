import { TelegramClient, events } from "teleproto";
import { UpdateConnectionState } from "teleproto/network";
import { StringSession } from "teleproto/sessions";
import { MediaScheduler } from "teleproto/network/MediaScheduler";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";
import { initializeClientSession } from "./loginManager";

// ── Mitigate teleproto "Media request deadline exceeded" ──────────────────
// teleproto's MediaScheduler hardcodes REQUEST_DEADLINE_MS = 15_000 (15 s).
// When a DC connection is slow or the network is congested, both
// ensureConnected() and the actual RPC can exhaust that budget, causing every
// getFile / savePart retry to fail with "Media request deadline exceeded".
//
// This monkey-patch wraps the private _run() method to add **internal**
// retries (with backoff) when a timeout fires inside a single _run() call,
// so each getFile-level attempt gets up to 4 × 15 s = 60 s of effective time.
// ───────────────────────────────────────────────────────────────────────────
(function patchMediaDeadline() {
  const RETRIES = 3;
  const BACKOFF_MS = 2000;

  const originalRun = (MediaScheduler.prototype as any)._run as (
    ...args: any[]
  ) => Promise<any>;

  (MediaScheduler.prototype as any)._run = async function (
    this: any,
    ...args: any[]
  ) {
    let lastErr: any;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        return await originalRun.apply(this, args);
      } catch (err: any) {
        lastErr = err;
        const isTimeout =
          err?.errorMessage === "TIMEOUT" ||
          err?.message === "Media request deadline exceeded";
        if (!isTimeout) throw err;
        // Bail early if the caller already cancelled
        const signal: AbortSignal | undefined = args[4];
        if (signal?.aborted) throw err;
        if (attempt < RETRIES) {
          await new Promise<void>((r) =>
            setTimeout(r, BACKOFF_MS * (attempt + 1))
          );
        }
      }
    }
    throw lastErr;
  };
})();

// ── Mitigate teleproto Dcenter mediaTempFailed lockout ────────────────────
// teleproto/network/Dcenter.js: resetMediaTempKey() resets the temp key,
// expiresAt, and mediaBound, but OMITS mediaTempFailed.  Once a single
// bindTempAuthKey attempt fails (transient network hiccup, DC migration,
// or just bad luck), the Dcenter is permanently locked out of temp-key
// binding — every subsequent media request falls back to the permanent
// auth key.  If that permanent key is also stale for the media DC,
// MTProtoSender._handleBadAuthKey fires "Broken authorization key for dc
// N, resetting…" and the 15-second MediaScheduler deadline kills the
// request before the full DH + bindTempAuthKey dance completes.
//
// Fix: monkey-patch resetMediaTempKey to also clear mediaTempFailed so
// the next media connection tries a fresh temp-key bind.
// ───────────────────────────────────────────────────────────────────────────
(function patchDcenterMediaTempFailed() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Dcenter } = require("teleproto/network/Dcenter");
    if (!Dcenter) return;

    const originalReset = (Dcenter.prototype as any).resetMediaTempKey as () => void;

    (Dcenter.prototype as any).resetMediaTempKey = function (this: any) {
      originalReset.call(this);
      // Clear the permanent failure flag so the next media connection
      // will attempt a fresh DH + bindTempAuthKey instead of falling
      // back to the (potentially stale) permanent auth key.
      this.mediaTempFailed = false;
    };
  } catch (_) {
    // teleproto not available — skip patch
  }
})();

// ── Mitigate teleproto Network: clear permanent auth key on media DC break ─
// When a non-main media DC's permanent key is broken, teleproto only resets
// the temp key — it never clears the broken permanent key. The next
// connection will attempt temp-key binding anchored on the stale permanent
// key, fail, and loop forever.
//
// Fix: after the original _onSenderBreak, wipe the permanent auth key for
// the affected media DC — but ONLY when that DC is NOT the session's main
// DC. Clearing the main DC's key would kill the primary connection and
// trigger a runtime reload (which nukes in-flight media operations anyway).
// ───────────────────────────────────────────────────────────────────────────
(function patchNetworkOnSenderBreak() {
  try {
    const { Network } = require("teleproto/network/Network");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bareDcId, isDownloadDcId, isUploadDcId } = require("teleproto/network/core_types");
    if (!Network) return;

    const originalBreak = Network.prototype._onSenderBreak as (
      shiftedDcId: number,
      slot: any
    ) => void;

    Network.prototype._onSenderBreak = function (
      this: any,
      shiftedDcId: number,
      slot: any
    ) {
      originalBreak.call(this, shiftedDcId, slot);

      if (isDownloadDcId(shiftedDcId) || isUploadDcId(shiftedDcId)) {
        const dcId = bareDcId(shiftedDcId);
        // NEVER clear the permanent key for the session's main DC — that
        // would drop the primary connection and trigger a runtime reload
        // that kills in-flight media operations on every other DC.
        if (dcId === this._client.session.dcId) return;

        try {
          const dcenter = this._client._dcenters.get(dcId);
          if (dcenter) {
            dcenter.authKey.setKey(undefined).catch(() => {});
            dcenter.mediaBound = false;
          }
          this._client.session.setAuthKey(undefined, dcId);
        } catch (_) {}
      }
    };
  } catch (_) {
    // teleproto not available — skip patch
  }
})();
import {
  loadPluginsForRuntime,
  unloadPluginsForRuntime,
} from "./pluginManager";
import { resetCircuitBreaker } from "./channelGapBreaker";
import { loadSwitchState, saveSwitchState, DEFAULT_SWITCH_HOME } from "./versionSwitchState";

import {
  createGenerationContext,
  type DrainResult,
  type GenerationContext,
} from "./generationContext";

export type { GenerationContext };

export type RuntimeState =
  | "starting"
  | "running"
  | "reloading"
  | "stopping"
  | "draining"
  | "failed";

export interface TeleBoxRuntime {
  generation: number;
  state: RuntimeState;
  client: TelegramClient;
  context: GenerationContext;
  signal: AbortSignal;
  createdAt: number;
  meId?: string;
}

const RUNTIME_DRAIN_TIMEOUT_MS = 15_000;
const CLIENT_DESTROY_TIMEOUT_MS = 15_000;

let currentRuntime: TeleBoxRuntime | null = null;
let transitionPromise: Promise<TeleBoxRuntime | void> | null = null;
let nextGeneration = 1;

function logDrainResult(runtime: TeleBoxRuntime, reason: string, result: DrainResult): void {
  console.log(
    `[RUNTIME] Gen${runtime.generation} ${reason}: completed=${result.completed} timedOut=${result.timedOut} pendingTasks=${result.pendingTasks} pendingDisposables=${result.pendingDisposables} errors=${result.errors.length}`
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createClient(): Promise<TelegramClient> {
  const api = await getApiConfig();
  const proxy = api.proxy;
  if (proxy) {
    console.log("使用代理连接 Telegram:", proxy);
  }

  const client = new TelegramClient(
    new StringSession(api.session),
    api.api_id!,
    api.api_hash!,
    {
      connectionRetries: Infinity,
      reconnectRetries: Infinity,
      autoReconnect: true,
      deviceModel: readAppName(),
      proxy,
    }
  );
  client.setLogLevel(logger.getGramJSLogLevel() as never);
  return client;
}

async function destroyClient(client: TelegramClient): Promise<void> {
  await withTimeout(client.destroy(), CLIENT_DESTROY_TIMEOUT_MS, "destroy client");
}

async function buildRuntime(): Promise<TeleBoxRuntime> {
  const client = await createClient();
  const generation = nextGeneration++;
  const context = createGenerationContext(generation);
  const runtime: TeleBoxRuntime = {
    generation,
    state: "starting",
    client,
    context,
    signal: context.signal,
    createdAt: Date.now(),
  };

  const sessionInfo = await context.runTask(
    async () => await initializeClientSession(client, context),
    { label: "runtime:initialize-client-session" }
  );
  runtime.meId = sessionInfo.meId;

  // Connection watchdog: if the underlying client reports disconnected and
  // stays that way beyond the grace period, trigger a full runtime reload.
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const DISCONNECT_RELOAD_DELAY_MS = 30_000;
  client.addEventHandler((event) => {
    // Filter: only handle UpdateConnectionState events
    if (!(event instanceof UpdateConnectionState)) return;
    if (event.state === UpdateConnectionState.disconnected) {
      if (disconnectTimer) return; // already scheduled
      console.log(`[RUNTIME] Client disconnected, scheduling reload in ${DISCONNECT_RELOAD_DELAY_MS / 1000}s...`);
      disconnectTimer = setTimeout(async () => {
        disconnectTimer = null;
        if (runtime.state !== "running") return;
        console.log("[RUNTIME] Disconnect grace period elapsed, triggering runtime reload...");
        try {
          await reloadRuntime();
        } catch (err) {
          console.error("[RUNTIME] Auto-reload on disconnect failed:", err);
        }
      }, DISCONNECT_RELOAD_DELAY_MS);
    } else if (event.state === UpdateConnectionState.connected) {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
        console.log("[RUNTIME] Client reconnected before reload, canceling scheduled reload.");
      }
    }
  }, new events.Raw({}));

  // Register cleanup so the timer doesn't fire after destroy/shutdown.
  context.trackDisposable(() => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  }, { label: "runtime:disconnect-timer-cleanup" });

  return runtime;
}

async function resolvePendingSwitchNotification(
  client: TelegramClient,
  currentVersion: "teleproto" | "mtcute"
): Promise<void> {
  try {
    const state = loadSwitchState(DEFAULT_SWITCH_HOME);
    const notification = state.pendingNotification;
    if (!notification || notification.target !== currentVersion) return;

    const icon = currentVersion === "teleproto" ? "🟦" : "🟧";
    const label = currentVersion === "teleproto" ? "teleproto (gramjs)" : "mtcute (native)";
    const text = `🎉 **切换完成！** 现在运行的是 ${icon} ${label}\n\n想切回去？发 \`.switch revert\` 就行。`;

    await client.editMessage(notification.chatId, {
      message: notification.msgId,
      text,
    });

    state.pendingNotification = null;
    saveSwitchState(state, DEFAULT_SWITCH_HOME);
    console.log("[RUNTIME] Resolved pending switch notification");
  } catch {
    // 通知消息可能已被删除，或 peer 解析失败——静默清理不再重试
    try {
      const state = loadSwitchState(DEFAULT_SWITCH_HOME);
      if (state.pendingNotification) {
        state.pendingNotification = null;
        saveSwitchState(state, DEFAULT_SWITCH_HOME);
      }
    } catch { /* ignore */ }
  }
}

async function startFreshRuntime(): Promise<TeleBoxRuntime> {
  // Reset channel gap circuit-breaker state for the new runtime
  resetCircuitBreaker();
  const runtime = await buildRuntime();
  currentRuntime = runtime;
  try {
    await loadPluginsForRuntime(runtime);
    // 切换后上线后，编辑之前留下的"正在切换…"通知消息
    await resolvePendingSwitchNotification(runtime.client, "teleproto");
    runtime.state = "running";
    return runtime;
  } catch (error) {
    runtime.state = "failed";
    currentRuntime = null;
    runtime.context.abort("Runtime startup failed");
    await runtime.context.dispose(RUNTIME_DRAIN_TIMEOUT_MS).catch((disposeError) => {
      console.error("[RUNTIME] Failed to dispose runtime after startup error:", disposeError);
    });
    await destroyClient(runtime.client).catch((destroyError) => {
      console.error("[RUNTIME] Failed to destroy runtime after startup error:", destroyError);
    });
    throw error;
  }
}

async function drainRuntime(
  runtime: TeleBoxRuntime,
  reason: string,
  timeoutMs = RUNTIME_DRAIN_TIMEOUT_MS
): Promise<DrainResult> {
  runtime.state = "draining";
  console.log(`[RUNTIME] Gen${runtime.generation} draining: ${reason}`);
  runtime.context.abort(reason);
  const result = await runtime.context.dispose(timeoutMs);
  logDrainResult(runtime, reason, result);
  if (result.timedOut) {
    console.warn(
      `[RUNTIME] Gen${runtime.generation} drain timed out: ${result.pendingTasks} pending tasks, ${result.pendingDisposables} pending disposables.`
    );
  } else if (result.errors.length > 0) {
    console.warn(
      `[RUNTIME] Gen${runtime.generation} drained with ${result.errors.length} disposable error(s).`
    );
  } else {
    console.log(`[RUNTIME] Gen${runtime.generation} drain complete.`);
  }
  return result;
}

async function disposeRuntime(
  runtime: TeleBoxRuntime,
  reason: string
): Promise<DrainResult> {
  if (runtime.context.state === "disposed") {
    console.log(`[RUNTIME] Generation ${runtime.generation} already disposed before ${reason}.`);
    await destroyClient(runtime.client);
    return {
      completed: true,
      timedOut: false,
      errors: [],
      pendingTasks: 0,
      pendingDisposables: 0,
    };
  }

  const drainResult = await drainRuntime(runtime, reason);
  try {
    await destroyClient(runtime.client);
  } catch (error) {
    console.error(`[RUNTIME] Failed to destroy generation ${runtime.generation} client:`, error);
    throw error;
  }
  return drainResult;
}

export function getCurrentRuntime(): TeleBoxRuntime {
  if (!currentRuntime) {
    throw new Error("TeleBox runtime is not initialized");
  }
  return currentRuntime;
}

export function tryGetCurrentRuntime(): TeleBoxRuntime | null {
  return currentRuntime;
}

export function getCurrentGeneration(): number {
  return currentRuntime?.generation ?? 0;
}

export function isRuntimeTransitioning(): boolean {
  return transitionPromise !== null;
}

export function getCurrentGenerationContext(): GenerationContext {
  return getCurrentRuntime().context;
}

export function tryGetCurrentGenerationContext(): GenerationContext | null {
  return currentRuntime?.context ?? null;
}

export async function getGlobalClient(): Promise<TelegramClient> {
  return getCurrentRuntime().client;
}

export async function startRuntime(): Promise<TeleBoxRuntime> {
  if (currentRuntime?.state === "running") {
    return currentRuntime;
  }
  if (transitionPromise) {
    const runtime = await transitionPromise;
    if (!runtime || !("client" in runtime)) {
      throw new Error("Runtime transition did not produce a running runtime");
    }
    return runtime;
  }

  transitionPromise = (async () => {
    return await startFreshRuntime();
  })();

  try {
    const runtime = await transitionPromise;
    if (!runtime || !("client" in runtime)) {
      throw new Error("Runtime startup failed");
    }
    return runtime;
  } finally {
    transitionPromise = null;
  }
}

export async function reloadRuntime(): Promise<TeleBoxRuntime> {
  if (transitionPromise) {
    const runtime = await transitionPromise;
    if (!runtime || !("client" in runtime)) {
      throw new Error("Runtime reload failed");
    }
    return runtime;
  }

  transitionPromise = (async () => {
    if (!currentRuntime) {
      return await startFreshRuntime();
    }

    const oldRuntime = currentRuntime;
    oldRuntime.state = "reloading";

    try {
      await unloadPluginsForRuntime(oldRuntime);
      await disposeRuntime(oldRuntime, "Runtime reload");
    } catch (error) {
      oldRuntime.state = "failed";
      throw error;
    }

    const newRuntime = await buildRuntime();
    currentRuntime = newRuntime;

    try {
      await loadPluginsForRuntime(newRuntime);
      newRuntime.state = "running";
      return newRuntime;
    } catch (error) {
      console.error("[RUNTIME] Failed to load plugins after reload, keeping runtime alive:", error);
      // Keep the new runtime alive: it has a working client, only plugins failed.
      // Setting currentRuntime = null previously made the bot completely dead
      // (getGlobalClient() throws, all commands fail, no message delivery).
      newRuntime.state = "failed";
      currentRuntime = newRuntime;
      throw error;
    }
  })();

  try {
    const runtime = await transitionPromise;
    if (!runtime || !("client" in runtime)) {
      throw new Error("Runtime reload failed");
    }
    return runtime;
  } finally {
    transitionPromise = null;
  }
}

export async function shutdownRuntime(): Promise<void> {
  if (transitionPromise) {
    await transitionPromise;
  }
  if (!currentRuntime) return;

  const runtime = currentRuntime;
  runtime.state = "stopping";
  currentRuntime = null;

  runtime.context.abort("Runtime shutdown");
  await unloadPluginsForRuntime(runtime);
  await disposeRuntime(runtime, "Runtime shutdown");
}
