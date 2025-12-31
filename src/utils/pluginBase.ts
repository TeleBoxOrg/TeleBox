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

/**
 * 插件基类
 * @class Plugin
 * @description 所有插件必须继承此类
 */
abstract class Plugin {
  /**
   * 插件名称，不填则自动使用文件名
   */
  name?: string;
  
  /**
   * 命令是否忽略编辑消息
   * @default cmdIgnoreEdited (从环境变量 TB_CMD_IGNORE_EDITED 读取)
   */
  ignoreEdited?: boolean = cmdIgnoreEdited;
  
  /**
   * 插件描述，可以是字符串或返回字符串的函数
   */
  abstract description:
    | string
    | ((...args: any[]) => string | void)
    | ((...args: any[]) => Promise<string | void>);
  
  /**
   * 命令处理器
   * @example
   * cmdHandlers = {
   *   help: async (msg: Api.Message) => { ... }
   * }
   */
  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;
  
  /**
   * 消息监听器是否忽略编辑消息
   * @default true
   */
  listenMessageHandlerIgnoreEdited?: boolean = true;
  
  /**
   * 消息监听器
   * @param msg - 消息对象
   * @param options - 选项
   * @param options.isEdited - 是否为编辑消息
   */
  listenMessageHandler?: (
    msg: Api.Message,
    options?: { isEdited?: boolean }
  ) => Promise<void>;
  
  /**
   * 事件处理器
   * @example
   * eventHandlers = [
   *   {
   *     event: new NewMessage({}),
   *     handler: async (event) => { ... }
   *   }
   * ]
   */
  eventHandlers?: Array<{
    event?: any;
    handler: (event: any) => Promise<void>;
  }>;
  
  /**
   * 定时任务
   * @example
   * cronTasks = {
   *   backup: {
   *     cron: "0 0 * * *",
   *     description: "每日备份",
   *     handler: async (client) => { ... }
   *   }
   * }
   */
  cronTasks?: Record<string, CronTask>;
  
  /**
   * 插件销毁前调用，用于清理资源，防止内存泄漏
   * @description 所有插件必须实现此方法，清理所有外部资源
   * @example
   * async cleanup() {
   *   // 1. 清理定时器
   *   this.timers.forEach(timer => clearTimeout(timer));
   *   
   *   // 2. 关闭数据库连接
   *   if (this.db) await this.db.write();
   *   
   *   // 3. 移除事件监听器
   *   this.eventHandlers.forEach(({ handler, event }) => {
   *     client.removeEventHandler(handler, event);
   *   });
   * }
   * @returns {Promise<void>} 无返回值
   */
  abstract cleanup(): Promise<void> | void;
}

/**
 * 验证对象是否为有效的插件
 * @param obj - 要验证的对象
 * @returns {boolean} 是否为有效插件
 */
function isValidPlugin(obj: any): obj is Plugin {
  if (!obj) return false;
  
  // 验证 description
  const desc = obj.description;
  const isValidDescription =
    typeof desc === "string" || typeof desc === "function";
  if (!isValidDescription) return false;
  
  // 验证 cmdHandlers
  if (typeof obj.cmdHandlers !== "object" || obj.cmdHandlers === null) {
    return false;
  }
  
  // 验证 cmdHandlers 中的每个处理器都是函数
  for (const key of Object.keys(obj.cmdHandlers)) {
    if (typeof obj.cmdHandlers[key] !== "function") {
      return false;
    }
  }
  
  // 验证 listenMessageHandler (optional)
  if (
    obj.listenMessageHandler &&
    typeof obj.listenMessageHandler !== "function"
  ) {
    return false;
  }
  
  // 验证 cronTasks (optional)
  if (obj.cronTasks) {
    if (typeof obj.cronTasks !== "object") return false;
    for (const key of Object.keys(obj.cronTasks)) {
      const task = obj.cronTasks[key];
      if (typeof task.cron !== "string") return false;
      if (typeof task.handler !== "function") return false;
    }
  }
  
  // 验证 cleanup 方法 - 兼容旧插件
  // 新插件必须实现 cleanup()，但为了向后兼容，旧插件如果没有 cleanup 也通过验证
  // 新插件加载时会警告
  if (typeof obj.cleanup !== 'function') {
    console.warn(`[PluginValidation] ⚠️ Plugin "${obj.name || 'unnamed'}" is missing required cleanup() method. This may cause memory leaks.`);
    // 兼容旧插件，提供空的 cleanup 方法
    obj.cleanup = async () => {
      console.log(`[Plugin] Empty cleanup called for ${obj.name || 'unnamed'}`);
    };
  }
  
  return true;
}

export { Plugin, isValidPlugin };