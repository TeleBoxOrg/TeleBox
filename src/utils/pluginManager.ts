import path from "path";
import fs from "fs";
import { isValidPlugin, Plugin } from "@utils/pluginBase";
import type { PanelSettingsAdapter } from "@utils/pluginBase";
import { Dispatcher, MessageContext } from "@mtcute/dispatcher";
import { AliasDB } from "./aliasDB";
import { cronManager } from "./cronManager";
import { logger } from "./logger";
import { getErrorMessage } from "./errorHelpers";
import type { TeleBoxRuntime } from "./runtimeManager";
import {
  getCurrentGeneration,
  getGlobalClient,
  reloadRuntime,
  tryGetCurrentRuntime,
} from "./runtimeAccess";

type PluginEntry = {
  original?: string;
  aliasFinal?: string;
  plugin: Plugin;
};

const validPlugins: Plugin[] = [];
const plugins: Map<string, PluginEntry> = new Map();
const loadedPluginFiles: Set<string> = new Set();
let pluginLoadDepth = 0;

const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");
const PROJECT_ROOT = process.cwd();
const CACHE_PURGE_EXCLUDE = new Set<string>([
  path.resolve(PROJECT_ROOT, "src/utils/pluginManager.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/pluginManager.js"),
  path.resolve(PROJECT_ROOT, "src/utils/pluginBase.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/pluginBase.js"),
  path.resolve(PROJECT_ROOT, "src/utils/cronManager.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/cronManager.js"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeManager.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeManager.js"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeAccess.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeAccess.js"),
  // Logger overrides console.* once at startup. Purging it on reload caused
  // the new Logger class to capture the already-wrapped console.log as
  // "original", stacking another wrapper every reload (visible as nested
  // timestamps in PM2 logs).
  path.resolve(PROJECT_ROOT, "src/utils/logger.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/logger.js"),
  // channelGapBreaker holds the per-channel failure window + cooldown map.
  // Purging it on reload reset the 6h cooldown state, allowing the breaker
  // to re-fire repeatedly for the same channel within minutes. Also avoids
  // a split-brain where runtimeManager (excluded) and logger (was purged)
  // referenced different module instances.
  path.resolve(PROJECT_ROOT, "src/utils/channelGapBreaker.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/channelGapBreaker.js"),
]);

let prefixes = [".", "。", "$"];
const envPrefixes =
  process.env.TB_PREFIX?.split(/\s+/g).filter((p) => p.length > 0) || [];
if (envPrefixes.length > 0) {
  prefixes = envPrefixes;
} else if (process.env.NODE_ENV === "development") {
  prefixes = ["!", "！"];
}
logger.info(
  `[PREFIXES] ${prefixes.join(" ")} (${envPrefixes.length > 0 ? "" : "可"}使用环境变量 TB_PREFIX 覆盖, 多个前缀用空格分隔)`
);

function getPrefixes(): string[] {
  return prefixes;
}

function setPrefixes(newList: string[]): void {
  prefixes = newList;
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function isProjectFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized.startsWith(PROJECT_ROOT + path.sep);
}

function shouldPurgeCache(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = normalizePath(filePath);
  if (!isProjectFile(normalized)) return false;
  if (CACHE_PURGE_EXCLUDE.has(normalized)) return false;
  if (normalized.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (!/\.(ts|js|cjs|mjs|cts|mts)$/.test(normalized)) return false;
  return true;
}

function collectModuleSubtree(moduleId: string, visited = new Set<string>()): Set<string> {
  const resolved = require.resolve(moduleId);
  const mod = require.cache[resolved];
  if (!mod) return visited;
  if (visited.has(mod.id)) return visited;
  visited.add(mod.id);

  for (const child of mod.children || []) {
    if (child?.id && shouldPurgeCache(child.id)) {
      collectModuleSubtree(child.id, visited);
    }
  }

  return visited;
}

function purgeModuleCache(modulePaths: Iterable<string>): void {
  const idsToDelete = new Set<string>();

  for (const filePath of modulePaths) {
    try {
      const resolved = require.resolve(filePath);
      if (!shouldPurgeCache(resolved)) continue;
      idsToDelete.add(resolved);
      const subtree = collectModuleSubtree(resolved);
      for (const id of subtree) {
        if (shouldPurgeCache(id)) {
          idsToDelete.add(id);
        }
      }
    } catch (e: unknown) {
      logger.error("[pluginManager] operation failed:", e);
    }
  }

  for (const id of idsToDelete) {
    delete require.cache[id];
  }

  if (idsToDelete.size > 0) {
    logger.info(`[RELOAD] Purged ${idsToDelete.size} module cache entries.`);
  }
}

function dynamicRequireWithDeps(filePath: string) {
  try {
    const normalized = normalizePath(filePath);
    loadedPluginFiles.add(normalized);
    delete require.cache[require.resolve(normalized)];
    return require(normalized);
  } catch (err: unknown) {
    // Downgrade to debug for known missing-module errors (e.g. teleproto-dependent
    // plugins that haven't been migrated yet). Unexpected errors still log as errors.
    const isMissingModule = err instanceof Error
      && err.message?.startsWith("Cannot find module");
    if (isMissingModule) {
      logger.debug(`Skipped plugin ${filePath}: ${err.message}`);
    } else {
      logger.error(`Failed to require ${filePath}:`, err);
    }
    return null;
  }
}

async function setPlugins(basePath: string) {
  const files = fs
    .readdirSync(basePath)
    .filter((file) => file.endsWith(".ts"));

  const aliasDB = new AliasDB();
  const aliasList = aliasDB.list();
  aliasDB.close();

  for (const file of files) {
    const pluginPath = path.resolve(basePath, file);
    const mod = dynamicRequireWithDeps(pluginPath);
    if (!mod) continue;
    const plugin = mod.default;

    if (isValidPlugin(plugin)) {
      if (!plugin.name) {
        plugin.name = path.basename(file, ".ts");
      }

      validPlugins.push(plugin);
      const cmds = Object.keys(plugin.cmdHandlers);

      for (const cmd of cmds) {
        plugins.set(cmd, { plugin });

        const relatedAliases = aliasList.filter(
          (rec) => rec.final === cmd || rec.final.startsWith(cmd + " ")
        );

        for (const rec of relatedAliases) {
          plugins.set(rec.original, {
            plugin,
            original: cmd,
            aliasFinal: rec.final,
          });
        }
      }
    }
  }
}

function isPluginLoadInProgress(): boolean {
  return pluginLoadDepth > 0;
}

function getPluginEntry(command: string): PluginEntry | undefined {
  return plugins.get(command);
}

function listCommands(): string[] {
  return Array.from(plugins.keys()).sort((a, b) => a.localeCompare(b));
}

function getCommandFromMessage(
  msg: MessageContext | string,
  diyPrefixes?: string[]
): string | null {
  let pfs = getPrefixes();
  if (diyPrefixes && diyPrefixes.length > 0) {
    pfs = diyPrefixes;
  }
  const text = typeof msg === "string" ? msg : msg.text;
  if (!text) return null;

  const matched = pfs.find((p) => text.startsWith(p));
  if (!matched) return null;

  const rest = text.slice(matched.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const aliasDB = new AliasDB();
  let aliasCandidate: string | null = null;
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join(" ");
    if (aliasDB.get(candidate)) {
      aliasCandidate = candidate;
      break;
    }
  }
  aliasDB.close();

  if (aliasCandidate) {
    return aliasCandidate;
  }

  const cmd = parts[0];
  if (/^[a-z0-9_]+$/i.test(cmd)) return cmd;

  return null;
}

async function dealCommandPluginWithMessage(param: {
  cmd: string;
  isEdited?: boolean;
  msg: MessageContext;
  trigger?: MessageContext;
}) {
  const { cmd, msg, isEdited, trigger } = param;
  const pluginEntry = getPluginEntry(cmd);

  try {
    if (!pluginEntry) return;

    if (isEdited && pluginEntry.plugin.ignoreEdited) {
      return;
    }

    const original = pluginEntry.original;
    let targetCmd = original || cmd;
    let targetMsg: MessageContext = msg;

    if (original && pluginEntry.aliasFinal && pluginEntry.aliasFinal !== original) {
      const pfs = getPrefixes();
      const text: string = msg.text || "";
      const matched = pfs.find((p) => text.startsWith(p)) || "";
      const rest = text.slice(matched.length).trim();
      const parts = rest.split(/\s+/).filter(Boolean);

      const aliasParts = cmd.split(/\s+/).filter(Boolean);
      const finalParts = pluginEntry.aliasFinal.split(/\s+/).filter(Boolean);

      if (
        parts.length >= aliasParts.length &&
        aliasParts.every((w, idx) => parts[idx] === w)
      ) {
        const extraParts = parts.slice(aliasParts.length);
        const newRest = [...finalParts, ...extraParts].join(" ");
        const newText = matched + newRest;

        // mtcute Message.text is a class getter backed by raw.message, so we
        // cannot Object.assign/defineProperty a fake message like gramjs did.
        // Wrap the real MessageContext in a Proxy that overrides `text` while
        // delegating every other property (and binding methods to the real
        // context so `this` stays intact).
        targetMsg = new Proxy(msg, {
          get(target, prop, receiver) {
            if (prop === "text") return newText;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as MessageContext;
      }
    }

    const handler = pluginEntry.plugin.cmdHandlers[targetCmd];
    if (handler) {
      await handler(targetMsg, trigger);
    }
  } catch (error: unknown) {
    logger.error("Command handler error:", error);
    const errorMsg = `处理命令时出错：${getErrorMessage(error)}`;
    try {
      await msg.edit({ text: errorMsg });
    } catch (editError: unknown) {
      logger.error("Failed to show command error message (client may be destroyed):", editError);
    }
  }
}

async function dealCommandPlugin(
  msg: MessageContext,
  isEdited: boolean
): Promise<void> {
  // gramjs exposed `msg.savedPeerId` to flag Saved Messages; mtcute has no such
  // property, so that check was always undefined and effectively dead. In
  // mtcute, a message is in Saved Messages when its chat id equals our own user
  // id. Compare against the self id cached on the runtime at login (avoids an
  // extra getMe() round-trip per message).
  const meId = tryGetCurrentRuntime()?.meId;
  const isSavedMessage = meId != null && String(msg.chat.id) === meId;
  // gramjs `msg.out` → mtcute `msg.isOutgoing`. Only react to our own outgoing
  // commands (or saved-messages), matching the userbot model.
  if (msg.isOutgoing || isSavedMessage) {
    const cmd = getCommandFromMessage(msg);
    if (cmd) {
      await dealCommandPluginWithMessage({ cmd, msg, isEdited });
    }
  }
}

async function dealNewMsgEvent(msg: MessageContext): Promise<void> {
  await dealCommandPlugin(msg, false);
}

async function dealEditedMsgEvent(msg: MessageContext): Promise<void> {
  await dealCommandPlugin(msg, true);
}

const listenerHandleEdited =
  process.env.TB_LISTENER_HANDLE_EDITED?.split(/\s+/g).filter(
    (p) => p.length > 0
  ) || [];

logger.info(
  `[LISTENER_HANDLE_EDITED] 不忽略监听编辑的消息的插件: ${
    listenerHandleEdited.length === 0
      ? "未设置"
      : listenerHandleEdited.join(", ")
  } (可使用环境变量 TB_LISTENER_HANDLE_EDITED 设置, 多个插件用空格分隔)`
);

async function runPluginSetup(plugin: Plugin, runtime: TeleBoxRuntime): Promise<void> {
  if (typeof plugin.setup !== "function") return;
  await runtime.context.runTask(
    async () => {
      await plugin.setup?.({
        generation: runtime.generation,
        signal: runtime.signal,
        lifecycle: runtime.context,
      });
    },
    { label: `plugin-setup:${plugin.name || "unknown"}` }
  );
}

function dealListenMessagePlugin(runtime: TeleBoxRuntime, dispatcher: Dispatcher): void {
  for (const plugin of validPlugins) {
    const messageHandler = plugin.listenMessageHandler;
    if (messageHandler) {
      dispatcher.onNewMessage(async (msg: MessageContext) => {
        if (runtime.generation !== getCurrentGeneration()) return;
        try {
          await messageHandler(msg);
        } catch (error: unknown) {
          logger.error("listenMessageHandler NewMessage error:", error);
        }
      });

      if (
        !plugin.listenMessageHandlerIgnoreEdited ||
        (plugin.name && listenerHandleEdited.includes(plugin.name))
      ) {
        dispatcher.onEditMessage(async (msg: MessageContext) => {
          if (runtime.generation !== getCurrentGeneration()) return;
          try {
            await messageHandler(msg, { isEdited: true });
          } catch (error: unknown) {
            logger.error("listenMessageHandler EditedMessage error:", error);
          }
        });
      }
    }

    // Raw event handlers: pluginBase exposes them as { kind, handler } where
    // handler receives the update context (typed unknown in the contract).
    // pluginManager narrows per kind here and wires them to the dispatcher.
    const eventHandlers = plugin.eventHandlers;
    if (Array.isArray(eventHandlers) && eventHandlers.length > 0) {
      for (const eh of eventHandlers) {
        const safeHandler = async (ctx: unknown) => {
          if (runtime.generation !== getCurrentGeneration()) return;
          try {
            await eh.handler(ctx);
          } catch (error: unknown) {
            logger.error("eventHandler error:", error);
          }
        };
        switch (eh.kind) {
          case "editMessage":
            dispatcher.onEditMessage((msg: MessageContext) => safeHandler(msg));
            break;
          case "rawUpdate":
            dispatcher.onRawUpdate((upd: unknown) => safeHandler(upd));
            break;
          case "newMessage":
          default:
            dispatcher.onNewMessage((msg: MessageContext) => safeHandler(msg));
            break;
        }
      }
    }
  }
}

function dealCronPlugin(runtime: TeleBoxRuntime): void {
  for (const plugin of validPlugins) {
    const cronTasks = plugin.cronTasks;
    if (cronTasks) {
      const keys = Object.keys(cronTasks);
      for (const key of keys) {
        const cronTask = cronTasks[key];
        cronManager.set(key, cronTask.cron, async () => {
          if (runtime.signal.aborted || runtime.generation !== getCurrentGeneration()) return;
          const client = await getGlobalClient();
          await cronTask.handler(client as never);
        }, runtime.context);
      }
    }
  }
}

async function runPluginCleanup(plugin: Plugin, runtime: TeleBoxRuntime): Promise<void> {
  if (typeof plugin.cleanup !== "function") return;
  // Do NOT wrap cleanup in runTask — by the time cleanup runs, the runtime
  // context has already been aborted, so runTask would reject immediately
  // with "Unload generation N" / "Runtime reload", preventing all plugin
  // cleanup from executing and crashing the reload flow.
  try {
    await plugin.cleanup?.();
  } catch (error: unknown) {
    logger.error(`[RELOAD] Plugin cleanup failed: ${plugin.name || "unknown"}`, error);
  }
}

async function unloadPluginsForRuntime(runtime: TeleBoxRuntime) {
  const oldPlugins = [...validPlugins];
  const oldPluginFiles = [...loadedPluginFiles];

  if (!runtime.signal.aborted) {
    runtime.context.abort(`Unload generation ${runtime.generation}`);
  }

  // 并行清理所有旧插件
  await Promise.all(oldPlugins.map((plugin) => runPluginCleanup(plugin, runtime)));

  logger.info(
    `[RELOAD] Gen${runtime.generation} unloading plugins`
  );

  validPlugins.length = 0;
  plugins.clear();
  loadedPluginFiles.clear();
  purgeModuleCache(oldPluginFiles);
}

async function loadPluginsForRuntime(runtime: TeleBoxRuntime) {
  pluginLoadDepth++;
  try {
    await setPlugins(USER_PLUGIN_PATH);
    await setPlugins(DEFAUTL_PLUGIN_PATH);
  } finally {
    pluginLoadDepth--;
  }

  // Isolate setup failures: a single plugin setup() throwing must NOT prevent
  // subsequent plugins from being initialized. Otherwise plugins later in the
  // load order keep their cmdHandlers registered (setPlugins already populated
  // the `plugins` map) but never receive their lifecycle, so invoking them
  // raises "lifecycle is not initialized" until the next reload.
  await Promise.all(validPlugins.map(async (plugin) => {
    try {
      await runPluginSetup(plugin, runtime);
    } catch (error: unknown) {
      logger.error(
        `[RELOAD] Plugin setup failed: ${plugin.name || "unknown"} (continuing with remaining plugins)`,
        error
      );
    }
  }));

  const { client } = runtime;

  // One Dispatcher per runtime generation. mtcute's Dispatcher.for(client)
  // owns all update handlers; on reload we call dispatcher.destroy() (tracked
  // as a single lifecycle disposable) instead of removing handlers one by one.
  const dispatcher = Dispatcher.for(client);
  runtime.dispatcher = dispatcher;
  runtime.context.trackDisposable(
    async () => {
      await dispatcher.destroy();
    },
    { label: `dispatcher:gen-${runtime.generation}` }
  );

  // Root command router: outgoing messages → command dispatch.
  dispatcher.onNewMessage(async (msg: MessageContext) => {
    if (runtime.generation !== getCurrentGeneration()) return;
    await dealNewMsgEvent(msg);
  });
  dispatcher.onEditMessage(async (msg: MessageContext) => {
    if (runtime.generation !== getCurrentGeneration()) return;
    await dealEditedMsgEvent(msg);
  });

  dealListenMessagePlugin(runtime, dispatcher);
  dealCronPlugin(runtime);
  logger.info("[RELOAD] Dispatcher + plugin handlers registered after reload.");
}

async function loadPlugins(): Promise<boolean> {
    if (isPluginLoadInProgress()) {
    logger.warn(
      "[RELOAD] Skip nested plugin reload while plugins are still being required. Move loadPlugins() out of module top-level initialization."
    );
    return false;
  }

  try {
    // Delegate to reloadRuntime() which handles:
    //   1. Abort the old generation context
    //   2. Unload old plugins & drain disposables
    //   3. Create a NEW generation/context/client
    //   4. Load plugins on the fresh runtime
    //
    // The old approach (unloadPluginsForRuntime + loadPluginsForRuntime on
    // the same aborted runtime) caused all runTask/trackDisposable calls in
    // the new load phase to immediately reject because the context was
    // already aborted, breaking plugin setup, event handlers, and cron tasks.
    await reloadRuntime();
    return true;
  } catch (error: unknown) {
    logger.error("[RELOAD] loadPlugins via reloadRuntime failed:", error);
    return false;
  }
}

function getLoadedPlugins(): Plugin[] {
  return [...validPlugins];
}

function listLoadedPlugins(): string[] {
  return validPlugins
    .filter(p => p.name)
    .map(p => p.name!);
}

function getPluginPanelAdapters(): PanelSettingsAdapter[] {
  const adapters: PanelSettingsAdapter[] = [];
  for (const plugin of validPlugins) {
    if (plugin.panelAdapter) {
      adapters.push(plugin.panelAdapter);
    }
  }
  return adapters;
}

export {
  getPrefixes,
  setPrefixes,
  loadPlugins,
  loadPluginsForRuntime,
  unloadPluginsForRuntime,
  listCommands,
  getPluginEntry,
  dealCommandPluginWithMessage,
  getCommandFromMessage,
  getLoadedPlugins,
  listLoadedPlugins,
  getPluginPanelAdapters,
};
