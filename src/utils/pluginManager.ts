import path from "path";
import fs from "fs";
import { isValidPlugin, Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
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
  aliasFinal?: string;
  plugin: Plugin;
};

const validPlugins: Plugin[] = [];
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
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  } catch (err) {
    console.error(`Failed to require ${filePath}:`, err);
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

  for await (const file of files) {
    const pluginPath = path.resolve(basePath, file);
    const mod = dynamicRequireWithDeps(pluginPath);
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

function getCommandFromMessage(
  msg: Api.Message | string,
  diyPrefixes?: string[]
): string | null {
  let pfs = getPrefixes();
  if (diyPrefixes && diyPrefixes.length > 0) {
    pfs = diyPrefixes;
  }
  const text = typeof msg === "string" ? msg : msg.message;

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
  msg: Api.Message;
  trigger?: Api.Message;
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
    let targetMsg: Api.Message = msg;

    if (original && pluginEntry.aliasFinal && pluginEntry.aliasFinal !== original) {
      const pfs = getPrefixes();
      const base: any = msg;
      const text: string = base.message || base.text || "";
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

        const newMsg: any = Object.create(Object.getPrototypeOf(base));
        Object.assign(newMsg, base);

        Object.defineProperty(newMsg, "message", {
          value: newText,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(newMsg, "text", {
          value: newText,
          writable: true,
          configurable: true,
        });

        targetMsg = newMsg as Api.Message;
      }
    }

    const handler = pluginEntry.plugin.cmdHandlers[targetCmd];
    if (handler) {
      await handler(targetMsg, trigger);
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
      client.addEventHandler(
        async (event: NewMessageEvent) => {
          try {
            await messageHandler(event.message);
          } catch (error) {
            console.log("listenMessageHandler NewMessage error:", error);
          }
        },
        new NewMessage()
      );

      if (
        !plugin.listenMessageHandlerIgnoreEdited ||
        (plugin.name && listenerHandleEdited.includes(plugin.name))
      ) {
        client.addEventHandler(
          async (event: any) => {
            try {
              await messageHandler(event.message, { isEdited: true });
            } catch (error) {
              console.log("listenMessageHandler EditedMessage error:", error);
            }
          },
          new EditedMessage({})
        );
      }
    }

    const eventHandlers = plugin.eventHandlers;
    if (Array.isArray(eventHandlers) && eventHandlers.length > 0) {
      for (const { event, handler } of eventHandlers) {
        client.addEventHandler(
          async (ev: any) => {
            try {
              await handler(ev);
            } catch (error) {
              console.log("eventHandler error:", error);
            }
          },
          event
        );
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
        cronManager.set(key, cronTask.cron, async () => {
          await cronTask.handler(client);
        });
      }
    }
  }
}

async function clearPlugins() {
  validPlugins.length = 0;
  plugins.clear();

  const client = await getGlobalClient();
  const handlers = client.listEventHandlers();
  for (const handler of handlers) {
    client.removeEventHandler(handler[1], handler[0]);
  }
}

async function loadPlugins() {
  await clearPlugins();
  cronManager.clear();

  await setPlugins(USER_PLUGIN_PATH);
  await setPlugins(DEFAUTL_PLUGIN_PATH);

  const client = await getGlobalClient();
  client.addEventHandler(dealNewMsgEvent, new NewMessage());
  client.addEventHandler(dealEditedMsgEvent, new EditedMessage({}));
  dealListenMessagePlugin(client);
  dealCronPlugin(client);
}

export {
  getPrefixes,
  setPrefixes,
  loadPlugins,
  listCommands,
  getPluginEntry,
  dealCommandPluginWithMessage,
  getCommandFromMessage,
};
