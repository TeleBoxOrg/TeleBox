import { Api, TelegramClient } from "teleproto";

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
  abstract description:
    | string
    | ((...args: any[]) => string | void)
    | ((...args: any[]) => Promise<string | void>);
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
  cleanup?(): Promise<void> | void;
}

// ✅ 运行时校验函数
function isValidPlugin(obj: any): obj is Plugin {
  if (!obj) return false;

  // description
  const desc = obj.description;
  const isValidDescription =
    typeof desc === "string" || typeof desc === "function";

  if (!isValidDescription) return false;

  // cmdHandlers
  if (typeof obj.cmdHandlers !== "object" || obj.cmdHandlers === null) {
    return false;
  }
  for (const key of Object.keys(obj.cmdHandlers)) {
    if (typeof obj.cmdHandlers[key] !== "function") {
      return false;
    }
  }

  // listenMessageHandler (optional)
  if (
    obj.listenMessageHandler &&
    typeof obj.listenMessageHandler !== "function"
  ) {
    return false;
  }

  // cronTasks (optional)
  if (obj.cronTasks) {
    if (typeof obj.cronTasks !== "object") return false;
    for (const key of Object.keys(obj.cronTasks)) {
      const task = obj.cronTasks[key];
      if (typeof task.cron !== "string") return false;
      if (typeof task.handler !== "function") return false;
    }
  }

  // cleanup (optional)
  if (obj.cleanup && typeof obj.cleanup !== "function") {
    return false;
  }

  return true;
}

export { Plugin, isValidPlugin };
