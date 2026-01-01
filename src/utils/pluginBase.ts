import { Api, TelegramClient } from "telegram";

type CronTask = {
  cron: string;
  description: string;
  handler: (client: TelegramClient) => Promise<void>;
};

const cmdIgnoreEdited = !!JSON.parse(
  process.env.TB_CMD_IGNORE_EDITED || "true"
);
console.log(
  `[CMD_IGNORE_EDITED] 命令监听忽略编辑的消息: ${cmdIgnoreEdited} (可使用环境变量 TB_CMD_IGNORE_EDITED 覆盖)`
);

abstract class Plugin {
  name?: string;
  ignoreEdited?: boolean = cmdIgnoreEdited;

  // 修复：简化 description 类型，允许字符串或返回字符串的函数
  abstract description: string | (() => string) | (() => Promise<string>);

  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;

  listenMessageHandlerIgnoreEdited?: boolean = true;
  listenMessageHandler?: (
    msg: Api.Message,
    options?: { isEdited?: boolean }
  ) => Promise<void>;

  eventHandlers?: Array<{
    event?: any;
    handler: (event: any) => Promise<void>;
  }>;

  cronTasks?: Record<string, CronTask>;

  abstract cleanup(): Promise<void> | void;
}

// 修复：简化 description 验证，确保函数返回字符串
function isValidPlugin(obj: any): obj is Plugin {
  if (!obj) return false;

  const desc = obj.description;
  if (typeof desc !== "string" && typeof desc !== "function") {
    console.warn('[PluginValidation] Invalid description type');
    return false;
  }

  // 修复：如果 description 是函数，验证其返回值是否为字符串
  if (typeof desc === "function") {
    try {
      const result = desc();
      if (typeof result !== "string" && typeof result !== "object") {
        // 如果是 Promise，验证其 resolve 值
        if (result && typeof result.then === "function") {
          // 对于异步函数，暂时通过验证，实际调用时再检查
        } else {
          console.warn('[PluginValidation] Description function must return a string');
          return false;
        }
      }
    } catch (e) {
      console.warn('[PluginValidation] Error calling description function:', e);
      return false;
    }
  }

  if (typeof obj.cmdHandlers !== "object" || obj.cmdHandlers === null) {
    console.warn('[PluginValidation] Invalid cmdHandlers structure');
    return false;
  }

  for (const key of Object.keys(obj.cmdHandlers)) {
    if (typeof obj.cmdHandlers[key] !== "function") {
      console.warn(`[PluginValidation] cmdHandlers[${key}] is not a function`);
      return false;
    }
  }

  if (obj.listenMessageHandler && typeof obj.listenMessageHandler !== "function") {
    console.warn('[PluginValidation] Invalid listenMessageHandler');
    return false;
  }

  if (obj.eventHandlers) {
    if (!Array.isArray(obj.eventHandlers)) {
      console.warn('[PluginValidation] eventHandlers must be an array');
      return false;
    }
    for (const handler of obj.eventHandlers) {
      if (typeof handler.handler !== "function") {
        console.warn('[PluginValidation] Invalid event handler function');
        return false;
      }
    }
  }

  if (obj.cronTasks) {
    if (typeof obj.cronTasks !== "object") {
      console.warn('[PluginValidation] cronTasks must be an object');
      return false;
    }
    for (const key of Object.keys(obj.cronTasks)) {
      const task = obj.cronTasks[key];
      if (typeof task.cron !== "string") {
        console.warn(`[PluginValidation] cronTasks[${key}].cron must be a string`);
        return false;
      }
      if (typeof task.handler !== "function") {
        console.warn(`[PluginValidation] cronTasks[${key}].handler must be a function`);
        return false;
      }
    }
  }

  // 验证 cleanup 方法
  if (typeof obj.cleanup !== 'function') {
    console.warn(`[PluginValidation] Plugin missing required cleanup() method`);
    // 兼容旧插件
    obj.cleanup = async () => {};
  }

  return true;
}

export { Plugin, isValidPlugin };