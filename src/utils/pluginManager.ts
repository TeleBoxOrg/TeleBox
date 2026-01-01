import path from "path";
import fs from "fs";
import { isValidPlugin, Plugin } from "@utils/pluginBase";
import { getGlobalClient, registerEventHandler } from "@utils/globalClient"; // 修复：导入 registerEventHandler
import { NewMessageEvent, NewMessage } from "telegram/events";
import { AliasDB } from "./aliasDB";
import { Api, TelegramClient } from "telegram";
import { cronManager } from "./cronManager";
import {
  EditedMessage,
  EditedMessageEvent,
} from "telegram/events/EditedMessage";

type PluginEntry = {
  original?: string;
  plugin: Plugin;
};

const validPlugins: Plugin[] = [];
const plugins: Map<string, PluginEntry> = new Map();
const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");

// 命令前缀配置
let prefixes = [".", "。", "$"];
const envPrefixes = process.env.TB_PREFIX?.split(/\s+/g).filter((p) => p.length > 0) || [];
if (envPrefixes.length > 0) {
  prefixes = envPrefixes;
} else if (process.env.NODE_ENV === "development") {
  prefixes = ["!", "！"];
}
console.log(
  `[PREFIXES] ${prefixes.join(" ")} (${envPrefixes.length > 0 ? "" : "可"}使用环境变量 TB_PREFIX 覆盖, 多个前缀用空格分隔)`
);

function getPrefixes(): string[] {
  return prefixes;
}

function setPrefixes(newList: string[]): void {
  prefixes = newList;
}

// 缓存 AliasDB 实例以避免频繁创建和关闭
let cachedAliasDB: AliasDB | null = null;

function getAliasDB(): AliasDB {
  if (!cachedAliasDB) {
    cachedAliasDB = new AliasDB();
  }
  return cachedAliasDB;
}

function dynamicRequireWithDeps(filePath: string) {
  try {
    // 清除模块缓存，确保重新加载
    const normalizedFilePath = path.normalize(filePath);
    const normalizedDirPath = path.normalize(path.dirname(filePath));
    
    Object.keys(require.cache).forEach(key => {
      const normalizedKey = path.normalize(key);
      // 修复：使用精确路径匹配
      if (normalizedKey === normalizedFilePath || 
          normalizedKey.startsWith(normalizedDirPath + path.sep)) {
        delete require.cache[normalizedKey];
      }
    });
    
    return require(normalizedFilePath);
  } catch (err) {
    console.error(`Failed to require ${filePath}:`, err);
    return null;
  }
}

async function setPlugins(basePath: string) {
  const files = fs.readdirSync(basePath).filter((file) => file.endsWith(".ts"));
  const aliasDB = getAliasDB(); // 使用缓存实例

  for await (const file of files) {
    const pluginPath = path.resolve(basePath, file);
    const mod = await dynamicRequireWithDeps(pluginPath);
    if (!mod) continue;

    const plugin = mod.default;
    if (plugin instanceof Plugin && isValidPlugin(plugin)) {
      if (!plugin.name) {
        plugin.name = path.basename(file, ".ts");
      }

      validPlugins.push(plugin);
      const cmds = Object.keys(plugin.cmdHandlers);
      for (const cmd of cmds) {
        plugins.set(cmd, { plugin });
        const alias = aliasDB.getOriginal(cmd);
        if (alias?.length > 0) {
          alias.forEach((a) => {
            plugins.set(a, { original: cmd, plugin });
          });
        }
      }
      console.log(`[PluginManager] Loaded plugin: ${plugin.name}`);
    }
  }
  // 注意：在 loadPlugins 结束时应关闭 AliasDB
}

function getPluginEntry(command: string): PluginEntry | undefined {
  return plugins.get(command);
}

function listCommands(): string[] {
  const cmds: Map<string, string> = new Map();
  for (const key of plugins.keys()) {
    const entry = plugins.get(key)!;
    if (entry.original) {
      cmds.set(key, `${key}(${entry.original})`);
    } else {
      cmds.set(key, key);
    }
  }
  return Array.from(cmds.values()).sort((a, b) => a.localeCompare(b));
}

// 优化：使用缓存的 AliasDB 实例
function getCommandFromMessage(msg: Api.Message | string, diyPrefixes?: string[]): string | null {
  let prefixes = getPrefixes();
  if (diyPrefixes && diyPrefixes.length > 0) {
    prefixes = diyPrefixes;
  }
  const text = typeof msg === "string" ? msg : msg.message;
  const matched = prefixes.find((p) => text.startsWith(p));
  if (!matched) return null;
  const rest = text.slice(matched.length).trim();
  const [cmd] = rest.split(/\s+/);
  if (!cmd) return null;
  if (/^[a-z0-9_]+$/i.test(cmd)) return cmd;

  const aliasDB = getAliasDB(); // 使用缓存实例
  if (aliasDB.get(cmd)) {
    return cmd;
  } else {
    return null;
  }
}

async function dealCommandPluginWithMessage(param: {
  cmd: string;
  isEdited?: boolean;
  msg: Api.Message;
  trigger?: Api.Message;
}) {
  const { cmd, msg, isEdited, trigger } = param;
  const pluginEntry = getPluginEntry(cmd);
  try {
    if (pluginEntry) {
      if (isEdited && pluginEntry.plugin.ignoreEdited) {
        return;
      }
      const original = pluginEntry.original;
      if (original) {
        await pluginEntry.plugin.cmdHandlers[original](msg, trigger);
      } else {
        await pluginEntry.plugin.cmdHandlers[cmd](msg, trigger);
      }
    }
  } catch (error) {
    console.log(error);
    await msg.edit({ text: `处理命令时出错：${error}` });
  }
}

async function dealCommandPlugin(
  event: NewMessageEvent | EditedMessageEvent
): Promise<void> {
  const msg = event.message;
  const savedMessage = (msg as any).savedPeerId;
  if (msg.out || savedMessage) {
    const cmd = getCommandFromMessage(msg);
    if (cmd) {
      const isEdited = event instanceof EditedMessageEvent;
      await dealCommandPluginWithMessage({ cmd, msg, isEdited });
    }
  }
}

async function dealNewMsgEvent(event: NewMessageEvent): Promise<void> {
  await dealCommandPlugin(event);
}

async function dealEditedMsgEvent(event: EditedMessageEvent): Promise<void> {
  await dealCommandPlugin(event);
}

const listenerHandleEdited = process.env.TB_LISTENER_HANDLE_EDITED?.split(/\s+/g).filter((p) => p.length > 0) || [];
console.log(
  `[LISTENER_HANDLE_EDITED] 不忽略监听编辑的消息的插件: ${
    listenerHandleEdited.length === 0 ? "未设置" : listenerHandleEdited.join(", ")
  } (可使用环境变量 TB_LISTENER_HANDLE_EDITED 设置, 多个插件用空格分隔)`
);

function dealListenMessagePlugin(client: TelegramClient): void {
  for (const plugin of validPlugins) {
    const messageHandler = plugin.listenMessageHandler;
    if (messageHandler) {
      // 修复：使用统一注册函数
      registerEventHandler(client, async (event: NewMessageEvent) => {
        try {
          await messageHandler(event.message);
        } catch (error) {
          console.log("listenMessageHandler NewMessage error:", error);
        }
      }, new NewMessage(), plugin.name || 'unnamed', 'listen');

      if (
        !plugin.listenMessageHandlerIgnoreEdited ||
        (plugin.name && listenerHandleEdited.includes(plugin.name))
      ) {
        // 修复：使用统一注册函数
        registerEventHandler(client, async (event: any) => {
          try {
            await messageHandler(event.message, {
              isEdited: true,
            });
          } catch (error) {
            console.log("listenMessageHandler EditedMessage error:", error);
          }
        }, new EditedMessage({}), plugin.name || 'unnamed', 'listen');
      }
    }

    const eventHandlers = plugin.eventHandlers;
    if (Array.isArray(eventHandlers) && eventHandlers.length > 0) {
      for (const { event, handler } of eventHandlers) {
        // 修复：使用统一注册函数
        registerEventHandler(client, async (event: any) => {
          try {
            await handler(event);
          } catch (error) {
            console.log("eventHandler error:", error);
          }
        }, event, plugin.name || 'unnamed', 'event');
      }
    }
  }
}

function dealCronPlugin(client: TelegramClient): void {
  for (const plugin of validPlugins) {
    const cronTasks = plugin.cronTasks;
    if (cronTasks) {
      const keys = Object.keys(cronTasks);
      for (const key of keys) {
        const cronTask = cronTasks[key];
        const taskName = plugin.name ? `${plugin.name}_${key}` : key;
        cronManager.set(taskName, cronTask.cron, async () => {
          try {
            await cronTask.handler(client);
          } catch (error) {
            console.error(`Cron task "${taskName}" error:`, error);
          }
        });
      }
    }
  }
}

// 修复：优化清理顺序
async function clearPlugins() {
  console.log('[PluginManager] Starting plugin cleanup...');

  // 1. 先停止所有 cron 任务，避免清理过程中触发
  console.log('[PluginManager] Clearing cron tasks...');
  cronManager.clear();

  // 2. 调用每个插件的 cleanup() 方法
  const cleanupPromises = validPlugins.map(async (plugin) => {
    try {
      console.log(`[PluginManager] Cleaning up plugin: ${plugin.name || 'unnamed'}`);
      if (typeof plugin.cleanup === 'function') {
        await plugin.cleanup();
        console.log(`[PluginManager] Plugin "${plugin.name || 'unnamed'}" cleanup completed`);
      } else {
        console.warn(`[PluginManager] ⚠️ Plugin "${plugin.name || 'unnamed'}" has no cleanup method`);
      }
    } catch (error) {
      console.error(`[PluginManager] Error cleaning up plugin "${plugin.name || 'unnamed'}":`, error);
    }
  });

  await Promise.all(cleanupPromises);

  // 3. 清空插件列表
  validPlugins.length = 0;
  plugins.clear();

  // 4. 最后移除所有事件处理器
  const client = await getGlobalClient();
  const handlers = client.listEventHandlers();
  for (const handler of handlers) {
    client.removeEventHandler(handler[1], handler[0]);
  }
  console.log('[PluginManager] All event handlers removed.');

  console.log('[PluginManager] Cleanup completed.');
}

async function loadPlugins() {
  console.log('[PluginManager] Starting plugin loading...');
  const startTime = Date.now();

  try {
    // 1. 清空现有插件
    await clearPlugins();

    // 2. 设置插件路径
    await setPlugins(USER_PLUGIN_PATH);
    await setPlugins(DEFAUTL_PLUGIN_PATH);

    // 3. 获取客户端
    const client = await getGlobalClient();

    // 4. 注册核心事件处理器 - 修复：使用统一注册函数
    registerEventHandler(client, dealNewMsgEvent, new NewMessage(), 'system', 'command');
    registerEventHandler(client, dealEditedMsgEvent, new EditedMessage({}), 'system', 'command');

    // 5. 注册插件特定的事件处理器
    dealListenMessagePlugin(client);
    dealCronPlugin(client);

    const loadTime = Date.now() - startTime;
    console.log(`[PluginManager] Plugin loading completed in ${loadTime}ms. Loaded ${validPlugins.length} plugins.`);

  } catch (error) {
    console.error('[PluginManager] Error loading plugins:', error);
    throw error;
  } finally {
    // 5. 关闭缓存的 AliasDB 实例
    if (cachedAliasDB) {
      cachedAliasDB.close();
      cachedAliasDB = null;
    }
  }
}

export {
  getPrefixes,
  setPrefixes,
  loadPlugins,
  listCommands,
  getPluginEntry,
  dealCommandPluginWithMessage,
  getCommandFromMessage,
  clearPlugins,
};