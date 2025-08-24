import path from "path";
import fs from "fs";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { NewMessageEvent, NewMessage } from "telegram/events";
import { AliasDB } from "./AliasDB";
import { Api, TelegramClient } from "telegram";

const basePlugins: Map<string, Plugin> = new Map(); // 用来储存没重命名的版本
const plugins: Map<string, Plugin> = new Map();

const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");

function getPrefixs(): string[] {
  let prefixs: string[] = ["$", ".", "。"];
  if (process.env.NODE_ENV === "development") {
    prefixs = ["！", "!"];
  }
  return prefixs;
}

function dynamicRequireWithDeps(filePath: string) {
  try {
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  } catch (err) {
    console.error(`Failed to require ${filePath}:`, err);
    return null; // 或者 throw err，看你想如何处理
  }
}

async function setPlugins(basePath: string) {
  const files = fs.readdirSync(basePath).filter((file) => file.endsWith(".ts"));
  console.log(`[PluginManager] Loading plugins from ${basePath}, found files:`, files);
  for (const file of files) {
    const pluginPath = path.resolve(basePath, file);
    console.log(`[PluginManager] Loading plugin: ${pluginPath}`);
    const mod = await dynamicRequireWithDeps(pluginPath);
    if (mod) {
      const plugin: Plugin = mod.default;
      if (plugin && plugin.command) {
        const command = plugin.command;
        plugins.set(command, plugin);
        basePlugins.set(command, plugin);
        console.log(`[PluginManager] Successfully loaded plugin: ${command}`);
        // 设置 alias 命令回复
        const db = new AliasDB();
        const alias = db.get(command);
        if (alias) {
          plugins.set(alias, plugin);
          console.log(`[PluginManager] Set alias ${alias} for ${command}`);
        }
      } else {
        console.log(`[PluginManager] Plugin ${file} has no valid command or default export`);
      }
    } else {
      console.log(`[PluginManager] Failed to load plugin: ${file}`);
    }
  }
}

function getPlugin(command: string): Plugin | undefined {
  return plugins.get(command);
}

function listCommands(): string[] {
  const db = new AliasDB();
  let cmds: string[] = Array.from(basePlugins.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((item) => {
      const anotherCMD = db.get(item);
      return anotherCMD ? `${item}(${anotherCMD})` : item;
    });
  return cmds;
}

async function getCommandFromMessage(msg: Api.Message): Promise<string | null> {
  let prefixs = getPrefixs();
  const text = msg.message;
  if (!prefixs.some((p) => text.startsWith(p))) return null;
  const [cmd] = text.slice(1).split(" ");
  if (!cmd) return null;
  return cmd;
}

async function dealCommandPluginWithMessage(param: {
  cmd: string;
  msg: Api.Message;
}) {
  const { cmd, msg } = param;
  const plugin = getPlugin(cmd);
  try {
    if (plugin) {
      await plugin.cmdHandler!(msg);
    } else {
      const availableCommands = listCommands();
      const helpText = `未知命令：${cmd}\n可用命令：${availableCommands.join(
        ", "
      )}`;
      await msg.edit({ text: helpText });
    }
  } catch (error) {
    console.log(error);
    await msg.edit({ text: `处理命令时出错：${error}` });
  }
}

async function dealCommandPlugin(event: NewMessageEvent) {
  const msg = event.message;
  // 检查是否发送到 收藏信息
  const savedMessage = (msg as any).savedPeerId;
  if (msg.out || savedMessage) {
    const cmd = await getCommandFromMessage(msg);
    if (cmd) {
      await dealCommandPluginWithMessage({ cmd, msg });
    }
  }
}

function dealListenMessagePlugin(client: TelegramClient): void {
  for (const plugin of basePlugins.values()) {
    const messageHandler = plugin.listenMessageHandler;
    if (messageHandler) {
      client.addEventHandler(async (event: NewMessageEvent) => {
        try {
          await messageHandler(event.message);
        } catch (error) {
          console.log("listenMessageHandler error:", error);
        }
      }, new NewMessage());
    }
  }
}

async function clearPlugins() {
  basePlugins.clear();
  plugins.clear();

  let client = await getGlobalClient();
  let handlers = client.listEventHandlers();
  for (const handler of handlers) {
    client.removeEventHandler(handler[1], handler[0]);
  }
}

async function loadPlugins() {
  // 清空现有插件
  await clearPlugins();

  // 设置插件路径
  await setPlugins(USER_PLUGIN_PATH);
  await setPlugins(DEFAUTL_PLUGIN_PATH);

  let client = await getGlobalClient();
  // 注册插件命令处理器
  client.addEventHandler(dealCommandPlugin, new NewMessage());
  // 添加监听新消息事件的处理器
  dealListenMessagePlugin(client);
}

export {
  loadPlugins,
  listCommands,
  getPlugin,
  dealCommandPluginWithMessage,
  getCommandFromMessage,
};
