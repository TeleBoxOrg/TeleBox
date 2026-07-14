import { TelegramClient, events } from "teleproto";
import { UpdateConnectionState } from "teleproto/network";
import { StringSession } from "teleproto/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";
import { initializeClientSession } from "./loginManager";

// ── Fix teleproto main-DC media upload deadlock ────────────────────────────
// teleproto (through 1.228.0) still routes upload.SaveFilePart through a
// separate media sender even when the target is the account's main DC. On
// affected sessions that media sender's auth is rejected and every part waits
// through all scheduler deadlines, while the exact same SaveFilePart succeeds
// immediately through the already-authorized main sender.
//
// Route only main-DC uploads through client.invoke(). Non-main DC operations
// retain the native MediaScheduler path (including migration/retry logic).
// This is a TeleBox runtime hook; the npm dependency remains untouched.
// ───────────────────────────────────────────────────────────────────────────
(function patchMainDcMediaUpload() {
  try {
    const { MediaScheduler } = require("teleproto/network/MediaScheduler");
    if (!MediaScheduler) return;

    interface PatchedMediaScheduler {
      _client: {
        session: { dcId: number };
        invoke(request: unknown): Promise<unknown>;
      };
    }

    const originalSavePart = MediaScheduler.prototype.savePart as (
      dcId: number,
      request: unknown,
      signal?: AbortSignal
    ) => Promise<unknown>;

    MediaScheduler.prototype.savePart = async function (
      this: PatchedMediaScheduler,
      dcId: number,
      request: unknown,
      signal?: AbortSignal
    ): Promise<unknown> {
      if (dcId !== this._client.session.dcId) {
        return originalSavePart.call(this, dcId, request, signal);
      }
      if (signal?.aborted) {
        throw new Error("Media operation aborted");
      }
      return this._client.invoke(request);
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
import { withTimeout } from "./asyncHelpers";
import { registerRuntimeAccess } from "./runtimeAccess";
import { flushPendingStatusDeletes } from "./postReloadMessage";

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

async function createClient(): Promise<TelegramClient> {
  const api = await getApiConfig();
  const proxy = api.proxy;
  if (proxy) {
    console.log("使用代理连接 Telegram:", proxy);
  }

  // teleproto ≥1.228.0 enables TCP keepalive + setNoDelay natively in
  // PromisedNetSockets (hardcoded 30s). No CustomPromisedNetSockets needed.
  // Keep proxy.timeout default so SOCKS connect doesn't hang forever.
  if (proxy && !proxy.timeout) {
    proxy.timeout = 10; // seconds
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
    const label = currentVersion === "teleproto" ? "TeleBox Classic" : "TeleBox-Next";
    const other = currentVersion === "teleproto" ? "TeleBox-Next" : "TeleBox Classic";
    const summary = notification.summary ? `\n\n${notification.summary}` : "";
    // Plain text — msg.edit often has no Markdown parseMode
    const text =
      `🎉 切换完成\n\n` +
      `现在运行：${icon} ${label}` +
      summary +
      `\n\n再切回去：发 .switch go（会切到 ${other}）。`;

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
    void flushPendingStatusDeletes().catch((e) => console.warn("[RUNTIME] pending status deletes:", e));
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

// Register late-bound accessors so pluginManager / channelGapBreaker /
// loginManager never need to import this module (breaks the cycle).
registerRuntimeAccess({
  getCurrentGeneration,
  tryGetCurrentRuntime,
  getGlobalClient,
  reloadRuntime,
  startRuntime,
});
