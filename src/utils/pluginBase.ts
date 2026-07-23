import type { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import type { GenerationContext } from "./generationContext";
import { logger } from "@utils/logger";
import { safeJsonParse } from "@utils/asyncHelpers";

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

/**
 * Panel Settings Adapter interface.
 * Plugins can implement this to provide their own settings UI in the Panel.
 * The adapter is auto-discovered when the plugin is loaded.
 */
export interface PanelSettingsAdapter {
  /** Unique ID for this adapter (typically plugin name) */
  id: string;
  /** Human-readable title shown in Panel settings list */
  title: string;
  /** Optional description */
  description?: string;
  /** Category for grouping: "系统" | "插件配置" | "权限" | "其他" */
  category?: string;
  /** Optional icon emoji */
  icon?: string;
  /** Return the JSON schema for settings form */
  getSchema(): PanelSettingField[] | Promise<PanelSettingField[]>;
  /** Return current values (secrets should be masked) */
  getValues(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Apply partial updates */
  setValues(patch: Record<string, unknown>): void | Promise<void>;
}

/** Field definition for panel settings form */
export interface PanelSettingField {
  key: string;
  label: string;
  type: PanelFieldType;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  secret?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  /** For provider-list: pipe-separated columns */
  providerColumns?: string;
  /** For provider-list: add button label */
  providerAddLabel?: string;
  /** For prompt-map: key placeholder */
  promptKeyPlaceholder?: string;
  /** For prompt-map: value placeholder */
  promptValuePlaceholder?: string;
  /** For tag-list: tag placeholder */
  tagPlaceholder?: string;
  /** For tag-list: allow duplicate tags */
  tagAllowDuplicates?: boolean;
}

/** Supported field types */
export type PanelFieldType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "textarea"
  | "json"
  | "password"
  | "provider-list"
  | "prompt-map"
  | "tag-list";

type PluginEventHandler = {
  kind?: "newMessage" | "editMessage" | "rawUpdate";
  handler: (ctx: unknown) => Promise<void>;
};

let cmdIgnoreEdited = true;

export function initPluginBaseConfig(): void {
  try {
    const raw = process.env.TB_CMD_IGNORE_EDITED;
    if (raw !== undefined) {
      const parsed = safeJsonParse<boolean>(raw);
      cmdIgnoreEdited = parsed !== undefined ? parsed : true;
    }
  } catch (e: unknown) {
    logger.warn(`[pluginBase] TB_CMD_IGNORE_EDITED 环境变量解析失败，使用默认值 true:`, e);
  }
  logger.info(
    `[CMD_IGNORE_EDITED] 命令监听忽略编辑的消息: ${cmdIgnoreEdited} (可使用环境变量 TB_CMD_IGNORE_EDITED 覆盖)`
  );
}

abstract class Plugin {
  name?: string;
  ignoreEdited?: boolean = cmdIgnoreEdited;
  abstract description: PluginDescription;
  abstract cmdHandlers: Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: MessageContext, trigger?: any) => Promise<void>
  >;
  listenMessageHandlerIgnoreEdited?: boolean = true;
  listenMessageHandler?: (
    msg: MessageContext,
    options?: { isEdited?: boolean }
  ) => Promise<void>;
  eventHandlers?: PluginEventHandler[];
  cronTasks?: Record<string, CronTask>;
  setup?(context: PluginRuntimeContext): Promise<void> | void;
  cleanup?(): Promise<void> | void;
  
  /** Optional: Panel settings adapter. If provided, auto-registers with Panel. */
  panelAdapter?: PanelSettingsAdapter;
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

  if (candidate.panelAdapter && typeof candidate.panelAdapter !== "object") {
    return false;
  }

  return true;
}

export { Plugin, isValidPlugin };
export type { PluginEventHandler, CronTask, PluginDescription };
