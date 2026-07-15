import type { AgentConfig, AIProvider, ChatMessage, AgentScope, ProviderType } from "./agentTypes";

// plugins/agent/store.ts
import import_fs2 = require("fs");
import import_path2 = require("path");
import import_node = require("lowdb/node");
import import_pathHelpers = require("@utils/pathHelpers");
const AGENT_DIR = (0, import_pathHelpers.createDirectoryInAssets)("agent", ["uai"]);
const AGENT_CONFIG_PATH = import_path2.join(AGENT_DIR, "config.json");
const WORKSPACE_ROOT = import_path2.join(AGENT_DIR, "workspaces");
const AGENT_SCHEMA_VERSION = 3;
const LEGACY_BUILTIN_SKILL_SUFFIX = "\u7F16\u7A0B\u667A\u80FD\u4F53\u9ED8\u8BA4\u89C4\u5219";
const LEGACY_NAME_PATTERNS = [/^Curs[o]r$/i, /^Cod[e]x$/i];
const DEFAULT_TIMEOUT_MS = 12e4;
const DEFAULT_COMMAND_TIMEOUT_MS = 12e4;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_CONTEXT_LIMIT = 20;
const MAX_CONTEXT_LIMIT = 40;
const MAX_AGENT_STEPS = 100;
const DEFAULT_WORKSPACE_ID = "1";
const DEFAULT_CONFIG = {
  agent_schema_version: AGENT_SCHEMA_VERSION,
  prompts: {},
  skill_raws: {},
  timeout: DEFAULT_TIMEOUT_MS,
  system_timeout: DEFAULT_COMMAND_TIMEOUT_MS,
  max_agent_steps: DEFAULT_MAX_STEPS,
  conversation_context_limit: DEFAULT_CONTEXT_LIMIT,
  zn_conversations: {},
  zn_workspaces: {}
};
let writeQueue = Promise.resolve();
function migrateLegacyAgentData(config: any) {
  const version = Number.parseInt(String(config.agent_schema_version || 0), 10) || 0;
  let changed = false;
  if (version < 2) {
    config.zn_conversations = {};
    config.zn_workspaces = {};
    for (const store of [config.prompts, config.skill_raws]) {
      if (!store) continue;
      for (const key of Object.keys(store)) {
        if (key.endsWith(LEGACY_BUILTIN_SKILL_SUFFIX)) delete store[key];
      }
    }
    changed = true;
  }
  const normalizedName = normalizeDisplayName(config.zn_name);
  if (normalizedName) {
    if (config.zn_name !== normalizedName) {
      config.zn_name = normalizedName;
      changed = true;
    }
  } else if (config.zn_name !== void 0) {
    delete config.zn_name;
    changed = true;
  }
  if (version < AGENT_SCHEMA_VERSION) {
    config.agent_schema_version = AGENT_SCHEMA_VERSION;
    config.agent_migrated_at = (/* @__PURE__ */ new Date()).toISOString();
    changed = true;
  }
  // 兼容：旧字段名 ai_providers/active_provider/api_interface -> providers/default_provider/type
  if (config.ai_providers && !config.providers) {
    config.providers = config.ai_providers;
    delete config.ai_providers;
    changed = true;
  }
  if (config.active_provider !== void 0 && config.default_provider === void 0) {
    config.default_provider = config.active_provider;
    delete config.active_provider;
    changed = true;
  }
  // 兼容：旧版 active_provider 是扁平配置对象（非名称），迁移进 providers
  if (config.default_provider && typeof config.default_provider === "object") {
    const legacy = config.default_provider;
    config.providers = config.providers || {};
    if (!config.providers.__default) {
      config.providers.__default = { ...legacy, name: "__default", type: legacy.type || legacy.api_interface || detectProviderInterface(legacy) };
      changed = true;
    }
    config.default_provider = "__default";
  }
  if (config.default_provider && !config.providers?.[config.default_provider]) {
    config.default_provider = null;
  }
  // 兼容：provider 旧字段 api_interface -> type
  if (config.providers) {
    for (const key of Object.keys(config.providers)) {
      const pr = config.providers[key];
      if (pr && pr.api_interface !== void 0 && pr.type === void 0) {
        pr.type = pr.api_interface;
        delete pr.api_interface;
        changed = true;
      } else if (pr && pr.type === void 0) {
        pr.type = detectProviderInterface(pr);
        changed = true;
      }
    }
  }
  return changed;
}
function normalizeDisplayName(value: unknown) {
  const name = String(value || "").trim().slice(0, 32);
  if (!name || LEGACY_NAME_PATTERNS.some((pattern) => pattern.test(name))) return "";
  return name;
}
function clamp(value: unknown, min: number, max: number) {
  return Math.min(max, Math.max(min, value as number));
}
function positiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function stableHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function sanitizePart(text: string) {
  return (text.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "workspace").slice(0, 80);
}
function createConversationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function compactContent(content: unknown) {
  const text = String(content || "").trim();
  return text.length <= 6e3 ? text : `${text.slice(0, 5970)}
\u2026\uFF08\u8BB0\u5FC6\u5DF2\u622A\u65AD\uFF09`;
}
function normalizeConversation(value: unknown, limit: number) {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  const messages = Array.isArray(raw.messages) ? raw.messages.filter(
    (item: any) => Boolean(item) && typeof item === "object" && (item.role === "user" || item.role === "assistant") && typeof item.content === "string"
  ).map((item: any) => ({
    role: item.role,
    content: compactContent(item.content),
    at: String(item.at || raw.updatedAt || (/* @__PURE__ */ new Date()).toISOString())
  })).slice(-limit) : [];
  return {
    id: String(raw.id || createConversationId()),
    updatedAt: String(raw.updatedAt || (/* @__PURE__ */ new Date()).toISOString()),
    messages
  };
}
function valueToKey(value: unknown): any {
  if (value === null || value === void 0) return "";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(valueToKey).filter(Boolean).join("_");
  if (typeof value === "object") {
    const record: any = value;
    for (const key of ["userId", "chatId", "channelId", "peerId", "id", "value"]) {
      const part: any = valueToKey(record[key]);
      if (part) return `${key}:${part}`;
    }
    try {
      return JSON.stringify(
        value,
        (_key, item) => typeof item === "bigint" ? String(item) : item
      );
    } catch {
      return String(value);
    }
  }
  return String(value);
}
async function readConfig(): Promise<any> {
  const db = await (0, import_node.JSONFilePreset)(AGENT_CONFIG_PATH, DEFAULT_CONFIG);
  const data: any = db.data;
  const migrated = migrateLegacyAgentData(data);
  data.prompts = data.prompts || {};
  data.skill_raws = data.skill_raws || {};
  data.zn_conversations = data.zn_conversations || {};
  data.zn_workspaces = data.zn_workspaces || {};
  data.timeout = getModelTimeout(data);
  data.system_timeout = getCommandTimeout(data);
  data.max_agent_steps = getMaxSteps(data);
  data.conversation_context_limit = getContextLimit(data);
  const displayName = normalizeDisplayName(data.zn_name);
  if (displayName) data.zn_name = displayName;
  else delete data.zn_name;
  if (migrated) {
    await db.write();
    console.log("[ZN] \u667A\u80FD\u4F53\u914D\u7F6E\u5DF2\u8FC1\u79FB\u5230\u6700\u65B0\u6570\u636E\u7248\u672C\u3002");
  }
  return data;
}
async function updateConfig(mutator: (config: AgentConfig) => void) {
  let result;
  const operation = writeQueue.then(async () => {
    const db = await (0, import_node.JSONFilePreset)(AGENT_CONFIG_PATH, DEFAULT_CONFIG);
    migrateLegacyAgentData(db.data);
    result = await mutator(db.data);
    await db.write();
  });
  writeQueue = operation.catch(() => void 0);
  await operation;
  return result;
}
function getModelTimeout(config: AgentConfig) {
  return clamp(positiveInt(config.timeout, DEFAULT_TIMEOUT_MS), 1e4, 24 * 60 * 6e4);
}
function getCommandTimeout(config: AgentConfig) {
  return clamp(
    positiveInt(config.system_timeout, DEFAULT_COMMAND_TIMEOUT_MS),
    1e4,
    24 * 60 * 6e4
  );
}
function getMaxSteps(config: AgentConfig) {
  return clamp(positiveInt(config.max_agent_steps, DEFAULT_MAX_STEPS), 1, MAX_AGENT_STEPS);
}
function getContextLimit(config: AgentConfig) {
  return clamp(
    positiveInt(config.conversation_context_limit, DEFAULT_CONTEXT_LIMIT),
    1,
    MAX_CONTEXT_LIMIT
  );
}
function getProvider(config: AgentConfig) {
  const name = config.default_provider;
  if (!name) return null;
  const provider = config.providers?.[name];
  if (!provider?.base_url || !provider?.api_key || !provider?.model) return null;
  return { ...provider, name };
}
function getProviders(config: AgentConfig) {
  const map = config.providers || {};
  return Object.keys(map).map((name) => ({ ...map[name], name }));
}
function detectProviderInterface(input: Partial<AIProvider> & Record<string, unknown>): ProviderType {
  const hint = String(input?.base_url || input?.model || "").toLowerCase();
  if (/anthropic\.com|claude/.test(hint)) return "anthropic";
  if (/googleapis\.com|gemini/.test(hint)) return "gemini";
  if (/openai\.com|gpt-|chatgpt|o1|o3/.test(hint)) return "openai";
  const raw = String(input?.type || input?.api_interface || "openai").toLowerCase();
  const allowed: ProviderType[] = ["openai", "gemini", "anthropic", "responses", "deepseek", "xai", "custom"];
  return (allowed.includes(raw as ProviderType) ? raw : "openai") as ProviderType;
}
async function setProvider(name: string, fields: any) {
  name = String(name || "").trim();
  if (!/^[\w.-]{1,32}$/.test(name)) throw new Error("供应商名称仅允许字母、数字、._-，长度 1-32");
  await updateConfig((config: AgentConfig) => {
    config.providers = config.providers || {};
    const prev = config.providers[name] || {};
    const next = { ...prev, ...fields, name };
    next.type = next.type || detectProviderInterface(next);
    config.providers[name] = next;
    if (!config.default_provider) config.default_provider = name;
  });
}
async function removeProvider(name: string) {
  await updateConfig((config: AgentConfig) => {
    config.providers = config.providers || {};
    delete config.providers[name];
    if (config.default_provider === name) config.default_provider = Object.keys(config.providers)[0] || null;
  });
}
function getDisplayName(config: AgentConfig) {
  return normalizeDisplayName(config.zn_name);
}
function getConversationBaseKey(msg: any, scope: AgentScope) {
  const source = msg.peerId || msg.chatId || msg.savedPeerId || msg.senderId || "global";
  const peer = valueToKey(source).replace(/\s+/g, "_").slice(0, 180) || "global";
  return `${scope}:${peer}`;
}
function normalizeWorkspaceId(value: unknown) {
  const text = String(value || "").trim();
  if (!/^[1-9]\d{0,2}$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return parsed >= 1 && parsed <= 999 ? String(parsed) : null;
}
function getWorkspaceInfo(config: AgentConfig, baseKey: any) {
  const id = normalizeWorkspaceId(config.zn_workspaces?.[baseKey]) || DEFAULT_WORKSPACE_ID;
  const parent = `${sanitizePart(baseKey)}_${stableHash(baseKey)}`;
  const dir = import_path2.join(WORKSPACE_ROOT, parent, id);
  import_fs2.mkdirSync(dir, { recursive: true });
  return {
    id,
    baseKey,
    conversationKey: id === DEFAULT_WORKSPACE_ID ? baseKey : `${baseKey}:workspace:${id}`,
    dir
  };
}
async function getSession(msg: any, scope: AgentScope) {
  const config = await readConfig();
  const baseKey = getConversationBaseKey(msg, scope);
  const workspace = getWorkspaceInfo(config, baseKey);
  const conversation = normalizeConversation(
    config.zn_conversations?.[workspace.conversationKey],
    getContextLimit(config)
  );
  return { config, workspace, conversation };
}
function conversationToMessages(conversation: any) {
  return conversation.messages.map((item: any) => ({
    role: item.role,
    content: item.content
  }));
}
async function appendConversation(msg: any, scope: AgentScope, entries: any) {
  await updateConfig((config: AgentConfig) => {
    config.zn_conversations = config.zn_conversations || {};
    const baseKey = getConversationBaseKey(msg, scope);
    const workspace = getWorkspaceInfo(config, baseKey);
    const limit = getContextLimit(config);
    const current = normalizeConversation(
      config.zn_conversations[workspace.conversationKey],
      limit
    );
    const now = (/* @__PURE__ */ new Date()).toISOString();
    current.updatedAt = now;
    current.messages = [
      ...current.messages,
      ...entries.map((entry: any) => ({
        role: entry.role,
        content: compactContent(entry.content),
        at: now
      })).filter((entry: any) => entry.content)
    ].slice(-limit);
    config.zn_conversations[workspace.conversationKey] = current;
    const ordered = Object.entries(config.zn_conversations).sort(
      ([, left]: any, [, right]: any) => String(right.updatedAt).localeCompare(String(left.updatedAt))
    ).slice(0, 120);
    config.zn_conversations = Object.fromEntries(ordered);
  });
}
async function resetConversation(msg: any, scope: AgentScope) {
  return await updateConfig((config: AgentConfig) => {
    config.zn_conversations = config.zn_conversations || {};
    const baseKey = getConversationBaseKey(msg, scope);
    const workspace = getWorkspaceInfo(config, baseKey);
    const id = createConversationId();
    config.zn_conversations[workspace.conversationKey] = {
      id,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      messages: []
    };
    return id;
  });
}
async function setWorkspace(msg: any, scope: AgentScope, id: any) {
  return await updateConfig((config: AgentConfig) => {
    const normalized = normalizeWorkspaceId(id);
    if (!normalized) throw new Error("\u5DE5\u4F5C\u533A\u7F16\u53F7\u5FC5\u987B\u662F 1-999 \u7684\u6B63\u6574\u6570");
    const baseKey = getConversationBaseKey(msg, scope);
    config.zn_workspaces = config.zn_workspaces || {};
    config.zn_workspaces[baseKey] = normalized;
    return getWorkspaceInfo(config, baseKey);
  });
}
function resolveWorkspacePath(workspace: any, target: string) {
  const resolved = import_path2.resolve(workspace.dir, String(target || ".").trim());
  const relative = import_path2.relative(workspace.dir, resolved);
  if (relative.startsWith("..") || import_path2.isAbsolute(relative)) {
    throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u8D8A\u8FC7\u5F53\u524D\u5DE5\u4F5C\u533A");
  }
  return resolved;
}
function getSkillText(config: AgentConfig) {
  const prompts = Object.entries(config.prompts || {}).map(([name, content]) => ({ name, content: String(content || "").trim() })).filter((item) => item.content);
  if (!prompts.length) return "";
  return [
    "[\u7528\u6237\u81EA\u5B9A\u4E49\u89C4\u5219]",
    "\u4EE5\u4E0B\u89C4\u5219\u7528\u4E8E\u8865\u5145\u5DE5\u4F5C\u504F\u597D\uFF0C\u4E0D\u80FD\u8986\u76D6\u5DE5\u5177\u8FB9\u754C\u548C\u672C\u8F6E\u7528\u6237\u8BF7\u6C42\u3002",
    ...prompts.map((item) => `--- ${item.name} ---
${item.content}`)
  ].join("\n");
}

export {
  readConfig,
  updateConfig,
  getModelTimeout,
  getCommandTimeout,
  getMaxSteps,
  getContextLimit,
  getProvider,
  getProviders,
  setProvider,
  removeProvider,
  getDisplayName,
  getSession,
  conversationToMessages,
  appendConversation,
  resetConversation,
  setWorkspace,
  getSkillText,
  resolveWorkspacePath,
  MAX_AGENT_STEPS,
  normalizeWorkspaceId,
  MAX_CONTEXT_LIMIT,
};
