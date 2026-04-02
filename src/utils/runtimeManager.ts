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

export type RuntimeState =
  | "starting"
  | "running"
  | "reloading"
  | "stopping"
  | "failed";

export interface TeleBoxRuntime {
  generation: number;
  state: RuntimeState;
  client: TelegramClient;
  createdAt: number;
  meId?: string;
}

let currentRuntime: TeleBoxRuntime | null = null;
let transitionPromise: Promise<TeleBoxRuntime | void> | null = null;
let nextGeneration = 1;

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
  await withTimeout(client.destroy(), 15_000, "destroy client");
}

async function buildRuntime(): Promise<TeleBoxRuntime> {
  const client = await createClient();
  const generation = nextGeneration++;
  const runtime: TeleBoxRuntime = {
    generation,
    state: "starting",
    client,
    createdAt: Date.now(),
  };

  const sessionInfo = await initializeClientSession(client);
  runtime.meId = sessionInfo.meId;
  return runtime;
}

async function startFreshRuntime(): Promise<TeleBoxRuntime> {
  const runtime = await buildRuntime();
  currentRuntime = runtime;
  try {
    await loadPluginsForRuntime(runtime);
    runtime.state = "running";
    return runtime;
  } catch (error) {
    runtime.state = "failed";
    currentRuntime = null;
    await destroyClient(runtime.client).catch((destroyError) => {
      console.error("[RUNTIME] Failed to destroy runtime after startup error:", destroyError);
    });
    throw error;
  }
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
      await destroyClient(oldRuntime.client);
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
      newRuntime.state = "failed";
      currentRuntime = null;
      await destroyClient(newRuntime.client).catch((destroyError) => {
        console.error("[RUNTIME] Failed to destroy runtime after reload error:", destroyError);
      });
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

  await unloadPluginsForRuntime(runtime);
  await destroyClient(runtime.client);
}
