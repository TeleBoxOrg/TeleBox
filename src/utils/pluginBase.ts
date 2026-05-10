import { Api, TelegramClient } from "teleproto";
import type { EventBuilder } from "teleproto/events/common";
import type { GenerationContext } from "./generationContext";

export interface PluginRuntimeContext {
  generation: number;
  signal: AbortSignal;
  lifecycle: GenerationContext;
}

type CronTask = {
  cron: string;
  description: string;
  handler: (client: TelegramClient) => Promise<void>;
};

type PluginDescription =
  | string
  | ((...args: unknown[]) => string | void)
  | ((...args: unknown[]) => Promise<string | void>);

type PluginEventHandler = {
  event?: EventBuilder;
  handler: (event: unknown) => Promise<void>;
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
  abstract description: PluginDescription;
  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;
  listenMessageHandlerIgnoreEdited?: boolean = true;
  listenMessageHandler?: (
    msg: Api.Message,
    options?: { isEdited?: boolean }
  ) => Promise<void>;
  eventHandlers?: PluginEventHandler[];
  cronTasks?: Record<string, CronTask>;
  setup?(context: PluginRuntimeContext): Promise<void> | void;
  cleanup?(): Promise<void> | void;
}

function isValidPlugin(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== "object") return false;
  const candidate = obj as Partial<Plugin>;

  const desc = candidate.description;
  const isValidDescription =
    typeof desc === "string" || typeof desc === "function";

  if (!isValidDescription) return false;

  if (typeof candidate.cmdHandlers !== "object" || candidate.cmdHandlers === null) {
    return false;
  }
  for (const key of Object.keys(candidate.cmdHandlers)) {
    if (typeof candidate.cmdHandlers[key] !== "function") {
      return false;
    }
  }

  if (
    candidate.listenMessageHandler &&
    typeof candidate.listenMessageHandler !== "function"
  ) {
    return false;
  }

  if (candidate.cronTasks) {
    if (typeof candidate.cronTasks !== "object") return false;
    for (const key of Object.keys(candidate.cronTasks)) {
      const task = candidate.cronTasks[key];
      if (typeof task.cron !== "string") return false;
      if (typeof task.handler !== "function") return false;
    }
  }

  if (candidate.setup && typeof candidate.setup !== "function") {
    return false;
  }

  if (candidate.cleanup && typeof candidate.cleanup !== "function") {
    return false;
  }

  return true;
}

export { Plugin, isValidPlugin };
