/**
 * TeleBox Panel — built-in Panel settings providers for AI plugins.
 * These register AI plugin configs into the Panel WebApp.
 */

import fs from "fs";
import path from "path";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { logger } from "@utils/logger";
import {
  registerPanelSettings,
  unregisterPanelSettings,
} from "./settingsRegistry";
import type { PanelSettingField } from "./types";

// ============ Helper types ============
interface AiProviderConfig {
  tag: string;
  url: string;
  key: string;
  type?: string;
  stream: boolean;
  responses: boolean;
}

interface AiConfig {
  configs: Record<string, AiProviderConfig>;
  currentChatTag: string;
  currentChatModel: string;
  currentSearchTag: string;
  currentSearchModel: string;
  currentImageTag: string;
  currentImageModel: string;
  currentVideoTag: string;
  currentVideoModel: string;
  imagePreview: boolean;
  videoPreview: boolean;
  videoAudio: boolean;
  videoDuration: number;
  prompt: string;
  collapse: boolean;
  timeout: number;
  telegraphToken: string;
  telegraph: {
    enabled: boolean;
    limit: number;
    list: Array<{ url: string; title: string; createdAt: string }>;
  };
}

interface AitcProviderConfig {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  type: "openai" | "gemini";
  auth_method: "bearer_token" | "api_key_header" | "query_param";
}

interface AitcConfig {
  providers: Record<string, AitcProviderConfig>;
  default_provider?: string;
  prompts: Record<string, string>;
  timeout: number;
  collapse: boolean;
}

interface UaiProviderConfig {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  type: "openai" | "gemini";
  auth_method: "bearer_token" | "api_key_header" | "query_param";
}

interface UaiConfig {
  providers: Record<string, UaiProviderConfig>;
  default_provider?: string;
  prompts: Record<string, string>;
  timeout: number;
  collapse: boolean;
}

interface SumCustomProvider {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  type?: "auto" | "chat" | "responses" | "gemini" | "anthropic" | "openai";
}

interface SumAIConfig {
  providers: Record<string, SumCustomProvider>;
  default_provider?: string;
  default_prompt?: string;
  default_spoiler?: boolean;
  default_timeout?: number;
  reply_mode?: boolean;
  max_output_length?: number;
  link_preview?: boolean;
}

// ============ Redaction helpers ============
function redactApiKeys<T extends { api_key?: string }>(
  obj: Record<string, T>
): Record<string, T> {
  const copy: Record<string, T> = { ...obj };
  for (const k of Object.keys(copy)) {
    if (copy[k].api_key) {
      copy[k] = { ...copy[k], api_key: "••••••••" } as T;
    }
  }
  return copy;
}

function redactApiKeysCustom<T extends Record<string, any>>(
  obj: Record<string, T>,
  keyField: string
): Record<string, T> {
  const copy: Record<string, T> = { ...obj };
  for (const k of Object.keys(copy)) {
    if (copy[k][keyField]) {
      copy[k] = { ...copy[k], [keyField]: "••••••••" } as T;
    }
  }
  return copy;
}

// ============ AI Plugin (ai.ts) ============
function registerAiPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("ai"), "config.json");

  registerPanelSettings({
    id: "ai",
    title: "AI 插件",
    description: "管理 AI 聊天/搜索/绘图/视频供应商配置",
    category: "AI",
    icon: "🤖",
    getSchema: (): PanelSettingField[] => [
      {
        key: "configsJson",
        label: "供应商配置 (JSON)",
        type: "json",
        description: `完整供应商配置。格式：
{
  "openai": {
    "tag": "openai",
    "url": "https://api.openai.com",
    "key": "sk-xxx",
    "type": "openai",
    "stream": true,
    "responses": false
  }
}
留空 key 表示不修改该供应商的 key。`,
        required: true,
      },
      { key: "currentChatTag", label: "默认聊天供应商", type: "string", placeholder: "openai" },
      { key: "currentChatModel", label: "默认聊天模型", type: "string", placeholder: "gpt-4o-mini" },
      { key: "currentSearchTag", label: "默认搜索供应商", type: "string", placeholder: "openai" },
      { key: "currentSearchModel", label: "默认搜索模型", type: "string", placeholder: "gpt-4o-mini" },
      { key: "currentImageTag", label: "默认绘图供应商", type: "string", placeholder: "openai" },
      { key: "currentImageModel", label: "默认绘图模型", type: "string", placeholder: "gpt-image-1" },
      { key: "currentVideoTag", label: "默认视频供应商", type: "string", placeholder: "openai" },
      { key: "currentVideoModel", label: "默认视频模型", type: "string", placeholder: "gpt-video-1" },
      { key: "prompt", label: "默认 Prompt", type: "textarea", description: "聊天模式默认系统提示词" },
      { key: "collapse", label: "折叠显示", type: "boolean", description: "AI 回答是否使用可折叠块引用" },
      { key: "timeout", label: "请求超时 (ms)", type: "number", min: 1000, max: 300000, default: 60000 },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as AiConfig;
        const configs = redactApiKeysCustom(raw.configs, "key");
        return {
          configsJson: JSON.stringify(configs, null, 2),
          currentChatTag: raw.currentChatTag || "",
          currentChatModel: raw.currentChatModel || "",
          currentSearchTag: raw.currentSearchTag || "",
          currentSearchModel: raw.currentSearchModel || "",
          currentImageTag: raw.currentImageTag || "",
          currentImageModel: raw.currentImageModel || "",
          currentVideoTag: raw.currentVideoTag || "",
          currentVideoModel: raw.currentVideoModel || "",
          prompt: raw.prompt || "",
          collapse: raw.collapse ?? false,
          timeout: raw.timeout ?? 60000,
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: AiConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as AiConfig;
      } else {
        db = {
          configs: {},
          currentChatTag: "", currentChatModel: "", currentSearchTag: "", currentSearchModel: "",
          currentImageTag: "", currentImageModel: "", currentVideoTag: "", currentVideoModel: "",
          imagePreview: false, videoPreview: false, videoAudio: false, videoDuration: 5,
          prompt: "", collapse: false, timeout: 60000,
          telegraphToken: "", telegraph: { enabled: false, limit: 10, list: [] },
        };
      }

      if (typeof patch.configsJson === "string") {
        try {
          const newConfigs = JSON.parse(patch.configsJson) as Record<string, AiProviderConfig>;
          for (const [name, cfg] of Object.entries(newConfigs)) {
            if (!cfg) continue;
            const old = db.configs[name] || {};
            if (cfg.key === "••••••••" || !cfg.key) cfg.key = old.key || "";
            db.configs[name] = cfg;
          }
        } catch (e) {
          throw new Error("供应商配置 JSON 格式错误: " + (e as Error).message);
        }
      }

      const fields: (keyof AiConfig)[] = [
        "currentChatTag", "currentChatModel", "currentSearchTag", "currentSearchModel",
        "currentImageTag", "currentImageModel", "currentVideoTag", "currentVideoModel",
        "prompt", "collapse", "timeout"
      ];
      for (const f of fields) {
        if (patch[f] !== undefined) (db as any)[f] = patch[f];
      }

      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ AITC Plugin (aitc.ts) ============
function registerAitcPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("aitc"), "aitc_config.db");

  registerPanelSettings({
    id: "aitc",
    title: "AITC 翻译插件",
    description: "自定义 Prompt 的 AI 翻译/转写配置",
    category: "AI",
    icon: "🌐",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providersJson",
        label: "供应商配置 (JSON)",
        type: "json",
        description: `格式：
{
  "my-openai": {
    "name": "my-openai",
    "base_url": "https://api.openai.com",
    "api_key": "sk-xxx",
    "model": "gpt-4o-mini",
    "type": "openai",
    "auth_method": "bearer_token"
  }
}`,
        required: true,
      },
      { key: "defaultProvider", label: "默认供应商", type: "string", placeholder: "my-openai" },
      { key: "promptsJson", label: "自定义 Prompt 预设 (JSON)", type: "json", description: `格式：{ "简写": "完整 prompt 文本" }` },
      { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2, default: 0.2 },
      { key: "collapse", label: "折叠显示", type: "boolean", description: "AI 回答使用可折叠块引用" },
      { key: "timeout", label: "请求超时 (ms)", type: "number", min: 1000, max: 300000, default: 30000 },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const Database = require("better-sqlite3");
        const db = new Database(DB_PATH, { readonly: true });
        const rows = db.prepare("SELECT key, value FROM config").all() as Array<{ key: string; value: string }>;
        db.close();

        const config: Record<string, string> = {};
        for (const r of rows) config[r.key] = r.value;

        let providersRedacted = "{}";
        if (config.aitc_providers) {
          try {
            const providers = JSON.parse(config.aitc_providers) as Record<string, AitcProviderConfig>;
            providersRedacted = JSON.stringify(redactApiKeys(providers), null, 2);
          } catch { }
        }

        return {
          providersJson: providersRedacted,
          defaultProvider: config.aitc_default_provider || "",
          promptsJson: config.aitc_prompts || "{}",
          temperature: config.aitc_temperature || "0.2",
          collapse: config.aitc_collapse === "1",
          timeout: parseInt(config.aitc_timeout || "30000", 10),
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const Database = require("better-sqlite3");
      const db = new Database(DB_PATH);
      db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)");

      if (typeof patch.providersJson === "string") {
        try {
          const newProviders = JSON.parse(patch.providersJson) as Record<string, AitcProviderConfig>;
          const existingRow = db.prepare("SELECT value FROM config WHERE key = ?").get("aitc_providers") as { value: string } | undefined;
          let existing: Record<string, AitcProviderConfig> = {};
          if (existingRow) { try { existing = JSON.parse(existingRow.value); } catch { } }
          for (const [name, cfg] of Object.entries(newProviders)) {
            if (!cfg) continue;
            const old = existing[name] || {};
            if (cfg.api_key === "••••••••" || !cfg.api_key) cfg.api_key = old.api_key || "";
            existing[name] = cfg;
          }
          stmt.run("aitc_providers", JSON.stringify(existing));
        } catch (e) {
          throw new Error("供应商配置 JSON 格式错误: " + (e as Error).message);
        }
      }

      const simpleKeys: [string, string][] = [
        ["defaultProvider", "aitc_default_provider"],
        ["promptsJson", "aitc_prompts"],
        ["temperature", "aitc_temperature"],
        ["collapse", "aitc_collapse"],
        ["timeout", "aitc_timeout"],
      ];
      for (const [patchKey, dbKey] of simpleKeys) {
        if (patch[patchKey] !== undefined) {
          const val = patch[patchKey];
          stmt.run(dbKey, typeof val === "boolean" ? (val ? "1" : "0") : String(val));
        }
      }

      db.close();
    },
  });
}

// ============ UAI Plugin (uai.ts) ============
function registerUaiPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("uai"), "config.json");

  registerPanelSettings({
    id: "uai",
    title: "UAI 用户消息分析",
    description: "引用消息 AI 总结/分析，支持多供应商",
    category: "AI",
    icon: "📊",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providersJson",
        label: "供应商配置 (JSON)",
        type: "json",
        description: `格式：
{
  "my-openai": { "name": "my-openai", "base_url": "https://api.openai.com", "api_key": "sk-xxx", "model": "gpt-4o", "type": "openai", "auth_method": "bearer_token" },
  "my-gemini": { "name": "my-gemini", "base_url": "https://generativelanguage.googleapis.com", "api_key": "xxx", "model": "gemini-2.0-flash", "type": "gemini", "auth_method": "query_param" }
}`,
        required: true,
      },
      { key: "defaultProvider", label: "默认供应商", type: "string", placeholder: "my-openai" },
      { key: "promptsJson", label: "自定义 Prompt (JSON)", type: "json", description: `格式：{ "简写": "prompt 文本" }，内置有 zj/fx` },
      { key: "collapse", label: "折叠显示 AI 回答", type: "boolean", default: true },
      { key: "timeout", label: "请求超时 (ms)", type: "number", min: 5000, max: 300000, default: 120000 },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as UaiConfig;
        const providers = redactApiKeys(raw.providers);
        return {
          providersJson: JSON.stringify(providers, null, 2),
          defaultProvider: raw.default_provider || "",
          promptsJson: JSON.stringify(raw.prompts || {}, null, 2),
          collapse: raw.collapse ?? true,
          timeout: raw.timeout ?? 120000,
        };
      } catch { return {}; }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: UaiConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as UaiConfig;
      } else {
        db = { providers: {}, prompts: {}, timeout: 120000, collapse: true };
      }

      if (typeof patch.providersJson === "string") {
        try {
          const newProviders = JSON.parse(patch.providersJson) as Record<string, UaiProviderConfig>;
          for (const [name, cfg] of Object.entries(newProviders)) {
            if (!cfg) continue;
            const old = db.providers[name] || {};
            if (cfg.api_key === "••••••••" || !cfg.api_key) cfg.api_key = old.api_key || "";
            db.providers[name] = cfg;
          }
          if (!db.default_provider && Object.keys(db.providers).length > 0) {
            db.default_provider = Object.keys(db.providers)[0];
          }
        } catch (e) {
          throw new Error("供应商配置 JSON 格式错误: " + (e as Error).message);
        }
      }

      if (typeof patch.defaultProvider === "string") db.default_provider = patch.defaultProvider;
      if (typeof patch.promptsJson === "string") { try { db.prompts = JSON.parse(patch.promptsJson); } catch { db.prompts = {}; } }
      if (typeof patch.collapse === "boolean") db.collapse = patch.collapse;
      if (typeof patch.timeout === "number") db.timeout = patch.timeout;

      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ SUM Plugin (sum.ts) ============
function registerSumPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("sum"), "summary_config.json");

  registerPanelSettings({
    id: "sum",
    title: "SUM 定时总结",
    description: "定时 AI 群聊总结任务与 AI 供应商配置",
    category: "AI",
    icon: "📋",
    getSchema: (): PanelSettingField[] => [
      {
        key: "aiConfigJson",
        label: "AI 供应商配置 (JSON)",
        type: "json",
        description: `完整 AI 配置。格式：
{
  "providers": {
    "openai": { "name": "OpenAI", "base_url": "https://api.openai.com", "api_key": "sk-xxx", "model": "gpt-4o", "type": "auto" },
    "gemini": { "name": "Gemini", "base_url": "https://generativelanguage.googleapis.com", "api_key": "xxx", "model": "gemini-2.5-flash", "type": "gemini" }
  },
  "default_provider": "openai",
  "default_prompt": "自定义提示词或留空用内置",
  "default_spoiler": false,
  "default_timeout": 120000,
  "reply_mode": false,
  "max_output_length": 4000,
  "link_preview": false
}`,
        required: true,
      },
      { key: "defaultPushTarget", label: "默认推送目标", type: "string", placeholder: "@channel 或 -100xxxxxx", description: "总结结果默认推送到的聊天" },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const db = await JSONFilePreset(DB_PATH, {
          seq: "0", tasks: [],
          aiConfig: {
            providers: {
              openai: { name: "OpenAI", base_url: "https://api.openai.com", api_key: "", model: "gpt-4o", type: "auto" },
              gemini: { name: "Gemini", base_url: "https://generativelanguage.googleapis.com", api_key: "", model: "gemini-2.5-flash", type: "gemini" },
            },
            default_provider: "openai", default_prompt: "", default_spoiler: false,
            default_timeout: 120000, reply_mode: false, max_output_length: 4000, link_preview: false,
          },
          defaultPushTarget: "",
        });

        const providers = redactApiKeys(db.data.aiConfig.providers);
        return {
          aiConfigJson: JSON.stringify({ ...db.data.aiConfig, providers }, null, 2),
          defaultPushTarget: db.data.defaultPushTarget || "",
        };
      } catch { return {}; }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const db = await JSONFilePreset(DB_PATH, {
        seq: "0", tasks: [],
        aiConfig: {
          providers: {
            openai: { name: "OpenAI", base_url: "https://api.openai.com", api_key: "", model: "gpt-4o", type: "auto" },
            gemini: { name: "Gemini", base_url: "https://generativelanguage.googleapis.com", api_key: "", model: "gemini-2.5-flash", type: "gemini" },
          },
          default_provider: "openai", default_prompt: "", default_spoiler: false,
          default_timeout: 120000, reply_mode: false, max_output_length: 4000, link_preview: false,
        },
        defaultPushTarget: "",
      });

      if (typeof patch.defaultPushTarget === "string") db.data.defaultPushTarget = patch.defaultPushTarget;

      if (typeof patch.aiConfigJson === "string") {
        try {
          const newCfg = JSON.parse(patch.aiConfigJson) as SumAIConfig;
          if (newCfg.providers) {
            const oldProviders: Record<string, SumCustomProvider> = db.data.aiConfig.providers as Record<string, SumCustomProvider> || {};
            for (const [name, cfg] of Object.entries(newCfg.providers)) {
              if (!cfg) continue;
              const old = oldProviders[name] || {};
              if (cfg.api_key === "••••••••" || !cfg.api_key) cfg.api_key = old.api_key || "";
              oldProviders[name] = cfg;
            }
            db.data.aiConfig.providers = oldProviders as typeof db.data.aiConfig.providers;
          }
          if (newCfg.default_provider) db.data.aiConfig.default_provider = newCfg.default_provider;
          if (newCfg.default_prompt !== undefined) db.data.aiConfig.default_prompt = newCfg.default_prompt;
          if (typeof newCfg.default_spoiler === "boolean") db.data.aiConfig.default_spoiler = newCfg.default_spoiler;
          if (typeof newCfg.default_timeout === "number") db.data.aiConfig.default_timeout = newCfg.default_timeout;
          if (typeof newCfg.reply_mode === "boolean") db.data.aiConfig.reply_mode = newCfg.reply_mode;
          if (typeof newCfg.max_output_length === "number") db.data.aiConfig.max_output_length = newCfg.max_output_length;
          if (typeof newCfg.link_preview === "boolean") db.data.aiConfig.link_preview = newCfg.link_preview;
        } catch (e) {
          throw new Error("AI 配置 JSON 格式错误: " + (e as Error).message);
        }
      }
      await db.write();
    },
  });
}

// ============ Export registration ============
export function registerAiPanelProviders(): void {
  registerAiPlugin();
  registerAitcPlugin();
  registerUaiPlugin();
  registerSumPlugin();
}

export function unregisterAiPanelProviders(): void {
  unregisterPanelSettings("ai");
  unregisterPanelSettings("aitc");
  unregisterPanelSettings("uai");
  unregisterPanelSettings("sum");
}