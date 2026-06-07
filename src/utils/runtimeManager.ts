import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";
import { initializeClientSession } from "./loginManager";
import {
  loadPluginsForRuntime,
  unloadPluginsForRuntime,
} from "./pluginManager";
import { resetCircuitBreaker } from "./channelGapBreaker";

import {
  createGenerationContext,
  type DrainResult,
  type GenerationContext,
  type GenerationContextSnapshot,
  type GenerationResourceStats,
  type ResourceResidual,
} from "./generationContext";

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

function formatResourceStats(stats: GenerationResourceStats): string {
  return Object.entries(stats)
    .filter(([, value]) => value.created > 0 || value.active > 0 || value.canceled > 0 || value.timedOut > 0)
    .map(([kind, value]) => {
      return `${kind}=active:${value.active},created:${value.created},drained:${value.completed},canceled:${value.canceled},timedOut:${value.timedOut}`;
    })
    .join("; ") || "none";
}

function formatResidualResources(residuals: ResourceResidual[], limit = 12): string {
  if (residuals.length === 0) return "none";
  const formatted = residuals.slice(0, limit).map((resource) => {
    return `${resource.kind}#${resource.id}:${resource.label}:${resource.state}:${resource.ageMs}ms`;
  });
  if (residuals.length > limit) {
    formatted.push(`+${residuals.length - limit} more`);
  }
  return formatted.join("; ");
}

function logGenerationSnapshot(prefix: string, snapshot: GenerationContextSnapshot): void {
  console.log(
    `${prefix} generation=${snapshot.generation} state=${snapshot.state} tasks=${snapshot.trackedTasks} disposables=${snapshot.trackedDisposables} stats=[${formatResourceStats(snapshot.stats)}] residual=[${formatResidualResources(snapshot.residualResources)}]`
  );
}

function logDrainResult(runtime: TeleBoxRuntime, reason: string, result: DrainResult): void {
  const residual = formatResidualResources(result.residualResources);
  console.log(
    `[RUNTIME] Generation ${runtime.generation} ${reason} diagnostics: canceled=${result.canceledResources}, drained=${result.drainedResources}, timedOut=${result.timedOutResources}, residual=${result.residualResources.length}, stats=[${formatResourceStats(result.stats)}], residualDetail=[${residual}]`
  );
}

function cloneEmptyDrainStats(stats: GenerationResourceStats): GenerationResourceStats {
  const cloned = {} as GenerationResourceStats;
  for (const [kind, value] of Object.entries(stats)) {
    cloned[kind as keyof GenerationResourceStats] = { ...value };
  }
  return cloned;
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

  let connectionRetries = 5;
  const envValue = process.env.TB_CONNECTION_RETRIES;
  if (envValue) {
    const parsed = Number(envValue);
    connectionRetries = Number.isInteger(parsed) ? parsed : 5;
  }

  console.log(
    `连接重试次数: ${connectionRetries}, 可使用环境变量 TB_CONNECTION_RETRIES 设置`
  );

  const client = new TelegramClient(
    new StringSession(api.session),
    api.api_id!,
    api.api_hash!,
    { connectionRetries, deviceModel: readAppName(), proxy }
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
  return runtime;
}

async function startFreshRuntime(): Promise<TeleBoxRuntime> {
  // Reset channel gap circuit-breaker state for the new runtime
  resetCircuitBreaker();
  const runtime = await buildRuntime();
  currentRuntime = runtime;
  try {
    await loadPluginsForRuntime(runtime);
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
  console.log(`[RUNTIME] Generation ${runtime.generation} aborting: ${reason}`);
  logGenerationSnapshot("[RUNTIME] Pre-drain snapshot", runtime.context.snapshot());
  runtime.context.abort(reason);
  const result = await runtime.context.dispose(timeoutMs);
  logDrainResult(runtime, reason, result);
  if (result.timedOut) {
    console.warn(
      `[RUNTIME] Generation ${runtime.generation} drain timed out with ${result.pendingTasks} pending tasks and ${result.pendingDisposables} pending disposables.`
    );
  } else if (result.errors.length > 0) {
    console.warn(
      `[RUNTIME] Generation ${runtime.generation} drained with ${result.errors.length} disposable error(s).`
    );
  } else {
    console.log(`[RUNTIME] Generation ${runtime.generation} drained and disposed.`);
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
      canceledResources: 0,
      drainedResources: 0,
      timedOutResources: 0,
      residualResources: [],
      stats: cloneEmptyDrainStats(runtime.context.snapshot().stats),
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
