import path from "path";
import fs from "fs";
import { isValidPlugin, Plugin } from "@utils/pluginBase";
import { getGlobalClient, cleanupGlobalClient, unregisterAllEventHandlers } from "@utils/globalClient";
import { NewMessageEvent, NewMessage } from "telegram/events";
import { AliasDB } from "./aliasDB";
import { Api, TelegramClient } from "telegram";
import { cronManager } from "./cronManager";
import {
  EditedMessage,
  EditedMessageEvent,
} from "telegram/events/EditedMessage";

type PluginEntry = {
  original?: string; // 主要用于重定向命令找到初始命令，从而可以调用相应的命令函数，不是重定向的可以不填写
  plugin: Plugin;
};
const validPlugins: Plugin[] = []; // 用来存储有效的插件，防止随意安装东西引起崩溃
const plugins: Map<string, PluginEntry> = new Map();
const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");
let prefixes = [".", "。", "$"];
const envPrefixes =
  process.env.TB_PREFIX?.split(/\s+/g).filter((p) => p.length > 0) || [];
if (envPrefixes.length > 0) {
  prefixes = envPrefixes;
} else if (process.env.NODE_ENV === "development") {
  prefixes = ["!", "！"];
}
console.log(
  `[PREFIXES] ${prefixes.join(" ")} (${
    envPrefixes.length > 0 ? "" : "可"
  }使用环境变量 TB_PREFIX 覆盖, 多个前缀用空格分隔)`
);

function getPrefixes(): string[] {
  return prefixes;
}

function setPrefixes(newList: string[]): void {
  prefixes = newList;
}

function dynamicRequireWithDeps(filePath: string) {
  try {
    // 清除模块缓存，确保重新加载
    Object.keys(require.cache).forEach(key => {
      if (key.includes(filePath) || key.includes(path.dirname(filePath))) {
        delete require.cache[key];
      }
    });
    
    return require(filePath);
  } catch (err) {
    console.error(`Failed to require ${filePath}:`, err);
    return null; // 或者 throw err，看你想如何处理
  }
}

async function setPlugins(basePath: string) {
  const files = fs.readdirSync(basePath).filter((file) => file.endsWith(".ts"));
  const aliasDB = new AliasDB();
  
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
  aliasDB.close();
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

function getCommandFromMessage(msg: Api.Message | string, diyPrefixes?: string[]): string | null {
  let prefixes = getPrefixes();
  if (diyPrefixes && diyPrefixes.length > 0) {
    prefixes = diyPrefixes;
  }
  const text = typeof msg === "string" ? msg : msg.message;
  // 如果发送的是 `!h`
  // console.log(msg?.message); // 这里是 !h
  // console.log(msg?.text); // 这里是 `!h`
  // 目前是认为可以执行
  // 仅当消息以任一前缀开头时才解析
  const matched = prefixes.find((p) => text.startsWith(p));
  if (!matched) return null;
  const rest = text.slice(matched.length).trim();
  const [cmd] = rest.split(/\s+/);
  if (!cmd) return null;
  if (/^[a-z0-9_]+$/i.test(cmd)) return cmd;
  const aliasDB = new AliasDB();
  if (aliasDB.get(cmd)) {
    aliasDB.close();
    return cmd;
  } else {
    aliasDB.close();
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
        // console.log(`插件 ${pluginEntry.plugin.constructor.name} 忽略编辑的消息`);
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
  // 检查是否发送到 收藏信息
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

const listenerHandleEdited =
  process.env.TB_LISTENER_HANDLE_EDITED?.split(/\s+/g).filter(
    (p) => p.length > 0
  ) || [];
console.log(
  `[LISTENER_HANDLE_EDITED] 不忽略监听编辑的消息的插件: ${
    listenerHandleEdited.length === 0
      ? "未设置"
      : listenerHandleEdited.join(", ")
  } (可使用环境变量 TB_LISTENER_HANDLE_EDITED 设置, 多个插件用空格分隔)`
);

function dealListenMessagePlugin(client: TelegramClient): void {
  for (const plugin of validPlugins) {
    const messageHandler = plugin.listenMessageHandler;
    if (messageHandler) {
      client.addEventHandler(async (event: NewMessageEvent) => {
        try {
          await messageHandler(event.message);
        } catch (error) {
          console.log("listenMessageHandler NewMessageerror:", error);
        }
      }, new NewMessage());
      
      if (
        !plugin.listenMessageHandlerIgnoreEdited ||
        (plugin.name && listenerHandleEdited.includes(plugin.name))
      ) {
        client.addEventHandler(async (event: any) => {
          try {
            await messageHandler(event.message, {
              isEdited: true,
            });
          } catch (error) {
            console.log("listenMessageHandler EditedMessage error:", error);
          }
        }, new EditedMessage({}));
      }
    }
    
    const eventHandlers = plugin.eventHandlers;
    if (Array.isArray(eventHandlers) && eventHandlers.length > 0) {
      for (const { event, handler } of eventHandlers) {
        client.addEventHandler(async (event: any) => {
          try {
            await handler(event);
          } catch (error) {
            console.log("eventHandler error:", error);
          }
        }, event);
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
        // 添加插件名称前缀，便于清理
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

/**
 * 清理所有插件
 * @description 调用每个插件的 cleanup() 方法，然后清理事件处理器和 cron 任务
 */
async function clearPlugins() {
  // 1. 调用每个插件的 cleanup() 方法
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
  
  // 等待所有插件清理完成
  await Promise.all(cleanupPromises);
  
  // 2. 清理事件处理器
  let removedHandlers = 0;
  try {
    removedHandlers = await unregisterAllEventHandlers();
    console.log(`[PluginManager] Removed ${removedHandlers} event handlers`);
  } catch (error) {
    console.error('[PluginManager] Error removing event handlers:', error);
  }
  
  // 3. 清理 cron 任务
  let removedCrons = 0;
  try {
    removedCrons = cronManager.clear();
    console.log(`[PluginManager] Removed ${removedCrons} cron tasks`);
  } catch (error) {
    console.error('[PluginManager] Error clearing cron tasks:', error);
  }
  
  // 4. 清空插件列表
  validPlugins.length = 0;
  plugins.clear();
  
  console.log(`[PluginManager] Cleanup completed. Removed ${removedHandlers} handlers and ${removedCrons} cron tasks.`);
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
    let client = await getGlobalClient();
    
    // 4. 注册插件命令处理器
    client.addEventHandler(dealNewMsgEvent, new NewMessage());
    
    // 5. 注册编辑消息处理器 (用于处理编辑后的命令)
    client.addEventHandler(dealEditedMsgEvent, new EditedMessage({}));
    
    // 6. 添加监听新消息事件的处理器
    dealListenMessagePlugin(client);
    
    // 7. 添加cron事件
    dealCronPlugin(client);
    
    const loadTime = Date.now() - startTime;
    console.log(`[PluginManager] Plugin loading completed in ${loadTime}ms. Loaded ${validPlugins.length} plugins.`);
    
  } catch (error) {
    console.error('[PluginManager] Error loading plugins:', error);
    throw error;
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