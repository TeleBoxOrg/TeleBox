/**
 * TeleBox Panel — built-in Panel settings providers for AI plugins.
 * These register AI plugin configs into the Panel WebApp.
 * Uses new field types: provider-list, prompt-map, tag-list for better UX.
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
  temperature: number;
  collapse: boolean;
  timeout: number;
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
function redactApiKeys(obj: Record<string, { api_key?: string }>): Record<string, { api_key?: string }> {
  const copy: Record<string, { api_key?: string }> = { ...obj };
  for (const k of Object.keys(copy)) {
    if (copy[k].api_key) {
      copy[k] = { ...copy[k], api_key: "••••••••" };
    }
  }
  return copy;
}

function redactKeyField(obj: Record<string, AiProviderConfig>): Record<string, AiProviderConfig> {
  const copy: Record<string, AiProviderConfig> = { ...obj };
  for (const k of Object.keys(copy)) {
    if (copy[k].key) {
      copy[k] = { ...copy[k], key: "••••••••" };
    }
  }
  return copy;
}

// ============ Provider list parsing ============
interface ParsedProvider {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  type: string;
  // ai.ts specific
  tag?: string;
  url?: string;
  key?: string;
  stream?: boolean;
  responses?: boolean;
  // aitc/uai specific
  auth_method?: string;
}

function parseProviderLine(line: string, columns: string[]): ParsedProvider | null {
  const parts = line.split("|").map((p) => p.trim());
  if (parts.length < columns.length) return null;
  const obj: ParsedProvider = { name: "", base_url: "", api_key: "", model: "", type: "" };
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const val = parts[i] || "";
    if (col === "name" || col === "tag") obj.name = val;
    else if (col === "base_url" || col === "url") obj.base_url = val;
    else if (col === "api_key" || col === "key") obj.api_key = val;
    else if (col === "model") obj.model = val;
    else if (col === "type") obj.type = val;
    else if (col === "auth_method") obj.auth_method = val;
    else if (col === "stream") obj.stream = val === "true";
    else if (col === "responses") obj.responses = val === "true";
    else if (col === "tag") obj.tag = val;
  }
  return obj.name ? obj : null;
}

function stringifyProvider(p: ParsedProvider, columns: string[]): string {
  return columns
    .map((col) => {
      if (col === "name" || col === "tag") return p.name;
      if (col === "base_url" || col === "url") return p.base_url;
      if (col === "api_key" || col === "key") return p.api_key || "••••••••";
      if (col === "model") return p.model;
      if (col === "type") return p.type;
      if (col === "auth_method") return p.auth_method || "";
      if (col === "stream") return p.stream ? "true" : "false";
      if (col === "responses") return p.responses ? "true" : "false";
      return "";
    })
    .join(" | ");
}

// ============ AI Plugin (ai.ts) ============
function registerAiPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("ai"), "config.json");

  registerPanelSettings({
      id: "ai",
      title: "AI 插件",
      description: "管理 AI 聊天/搜索/绘图/视频供应商配置",
      category: "插件配置",
      icon: "🤖",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providers",
        label: "供应商配置",
        type: "provider-list",
        description:
          "每行一个供应商，用 | 分隔：Tag | URL | Key | Type | Stream | Responses\n示例：openai | https://api.openai.com | sk-xxx | openai | true | false\n留空 Key 表示保持原值不修改。",
        required: true,
        providerColumns: "tag|url|key|type|stream|responses",
        providerAddLabel: "+ 添加供应商",
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
        const configs = redactKeyField(raw.configs);
        const columns = ["tag", "url", "key", "type", "stream", "responses"];
        const lines = Object.values(configs).map((c) => {
          const p: ParsedProvider = {
            name: c.tag,
            base_url: c.url || "",
            api_key: c.key || "",
            model: "",
            type: c.type || "",
            stream: c.stream,
            responses: c.responses,
          };
          return stringifyProvider(p, columns);
        });

        return {
          providers: lines.join("\n"),
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

      if (typeof patch.providers === "string") {
        const lines = patch.providers.split("\n").filter((l) => l.trim());
        const columns = ["tag", "url", "key", "type", "stream", "responses"];
        const newConfigs: Record<string, AiProviderConfig> = {};
        for (const line of lines) {
          const parsed = parseProviderLine(line, columns);
          if (!parsed || !parsed.name) continue;
          const old = db.configs[parsed.name] || {};
          if (parsed.api_key === "••••••••" || !parsed.api_key) parsed.api_key = old.key || "";
          newConfigs[parsed.name] = {
            tag: parsed.name,
            url: parsed.base_url || "",
            key: parsed.api_key || "",
            type: parsed.type || "",
            stream: parsed.stream ?? true,
            responses: parsed.responses ?? false,
          };
        }
        db.configs = newConfigs;
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
    category: "插件配置",
    icon: "🌐",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providers",
        label: "供应商配置",
        type: "provider-list",
        description:
          "每行一个供应商，用 | 分隔：Name | Base URL | API Key | Model | Type | Auth Method\n示例：my-openai | https://api.openai.com | sk-xxx | gpt-4o-mini | openai | bearer_token\n留空 Key 表示保持原值不修改。Type: openai/gemini，Auth: bearer_token/api_key_header/query_param",
        required: true,
        providerColumns: "name|base_url|api_key|model|type|auth_method",
        providerAddLabel: "+ 添加供应商",
      },
      { key: "defaultProvider", label: "默认供应商", type: "string", placeholder: "my-openai" },
      {
        key: "prompts",
        label: "自定义 Prompt 预设",
        type: "prompt-map",
        description: "简写 -> 完整 Prompt 文本，一行一条",
        promptKeyPlaceholder: "简写 (如: en2zh)",
        promptValuePlaceholder: "Prompt 文本",
      },
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

        let providersLines = "";
        if (config.aitc_providers) {
          try {
            const providers = JSON.parse(config.aitc_providers) as Record<string, AitcProviderConfig>;
            const redacted = redactApiKeys(providers);
            const columns = ["name", "base_url", "api_key", "model", "type", "auth_method"];
            providersLines = Object.values(redacted).map((p) => {
              const pp: ParsedProvider = { name: (p as any).name || "", base_url: (p as any).base_url || "", api_key: p.api_key || "••••••••", model: (p as any).model || "", type: (p as any).type || "", auth_method: (p as any).auth_method || "" };
              return stringifyProvider(pp, columns);
            }).join("\n");
          } catch { }
        }

        return {
          providers: providersLines,
          defaultProvider: config.aitc_default_provider || "",
          prompts: config.aitc_prompts || "{}",
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

      if (typeof patch.providers === "string") {
        const lines = patch.providers.split("\n").filter((l) => l.trim());
        const columns = ["name", "base_url", "api_key", "model", "type", "auth_method"];
        const existingRow = db.prepare("SELECT value FROM config WHERE key = ?").get("aitc_providers") as { value: string } | undefined;
        let existing: Record<string, AitcProviderConfig> = {};
        if (existingRow) { try { existing = JSON.parse(existingRow.value); } catch { } }
        const newProviders: Record<string, AitcProviderConfig> = {};
        for (const line of lines) {
          const parsed = parseProviderLine(line, columns);
          if (!parsed || !parsed.name) continue;
          const old = existing[parsed.name] || {};
          if (parsed.api_key === "••••••••" || !parsed.api_key) parsed.api_key = old.api_key || "";
          newProviders[parsed.name] = {
            name: parsed.name,
            base_url: parsed.base_url || "",
            api_key: parsed.api_key || "",
            model: parsed.model || "",
            type: (parsed.type as "openai" | "gemini") || "openai",
            auth_method: (parsed.auth_method as "bearer_token" | "api_key_header" | "query_param") || "bearer_token",
          };
        }
        stmt.run("aitc_providers", JSON.stringify(newProviders));
      }

      const simpleKeys: [string, string][] = [
        ["defaultProvider", "aitc_default_provider"],
        ["prompts", "aitc_prompts"],
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
    category: "插件配置",
    icon: "📊",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providers",
        label: "供应商配置",
        type: "provider-list",
        description:
          "每行一个供应商，用 | 分隔：Name | Base URL | API Key | Model | Type | Auth Method\n示例：my-openai | https://api.openai.com | sk-xxx | gpt-4o | openai | bearer_token\n留空 Key 表示保持原值不修改。Type: openai/gemini，Auth: bearer_token/api_key_header/query_param",
        required: true,
        providerColumns: "name|base_url|api_key|model|type|auth_method",
        providerAddLabel: "+ 添加供应商",
      },
      { key: "defaultProvider", label: "默认供应商", type: "string", placeholder: "my-openai" },
      {
        key: "prompts",
        label: "自定义 Prompt",
        type: "prompt-map",
        description: "简写 -> Prompt 文本，一行一条。内置有 zj/fx",
        promptKeyPlaceholder: "简写 (如: zj)",
        promptValuePlaceholder: "Prompt 文本",
      },
      { key: "collapse", label: "折叠显示 AI 回答", type: "boolean", default: true },
      { key: "timeout", label: "请求超时 (ms)", type: "number", min: 5000, max: 300000, default: 120000 },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as UaiConfig;
        const providers = redactApiKeys(raw.providers);
        const columns = ["name", "base_url", "api_key", "model", "type", "auth_method"];
        const lines = Object.values(providers).map((p: any) => {
          const pp: ParsedProvider = { name: p.name || "", base_url: p.base_url || "", api_key: p.api_key || "••••••••", model: p.model || "", type: p.type || "", auth_method: p.auth_method || "" };
          return stringifyProvider(pp, columns);
        });

        return {
          providers: lines.join("\n"),
          defaultProvider: raw.default_provider || "",
          prompts: JSON.stringify(raw.prompts || {}, null, 2),
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

      if (typeof patch.providers === "string") {
        const lines = patch.providers.split("\n").filter((l) => l.trim());
        const columns = ["name", "base_url", "api_key", "model", "type", "auth_method"];
        const newProviders: Record<string, UaiProviderConfig> = {};
        for (const line of lines) {
          const parsed = parseProviderLine(line, columns);
          if (!parsed || !parsed.name) continue;
          const old = db.providers[parsed.name] || {};
          if (parsed.api_key === "••••••••" || !parsed.api_key) parsed.api_key = old.api_key || "";
          newProviders[parsed.name] = {
            name: parsed.name,
            base_url: parsed.base_url || "",
            api_key: parsed.api_key || "",
            model: parsed.model || "",
            type: (parsed.type as "openai" | "gemini") || "openai",
            auth_method: (parsed.auth_method as "bearer_token" | "api_key_header" | "query_param") || "bearer_token",
          };
        }
        db.providers = newProviders;
        if (!db.default_provider && Object.keys(db.providers).length > 0) {
          db.default_provider = Object.keys(db.providers)[0];
        }
      }

      if (typeof patch.defaultProvider === "string") db.default_provider = patch.defaultProvider;
      if (typeof patch.prompts === "string") { try { db.prompts = JSON.parse(patch.prompts); } catch { db.prompts = {}; } }
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
    category: "插件配置",
    icon: "📋",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providers",
        label: "AI 供应商配置",
        type: "provider-list",
        description:
          "每行一个供应商，用 | 分隔：Name | Base URL | API Key | Model | Type\n示例：OpenAI | https://api.openai.com | sk-xxx | gpt-4o | auto\n留空 Key 表示保持原值不修改。Type: auto/chat/responses/gemini/anthropic/openai",
        required: true,
        providerColumns: "name|base_url|api_key|model|type",
        providerAddLabel: "+ 添加供应商",
      },
      { key: "defaultProvider", label: "默认供应商", type: "string", placeholder: "OpenAI" },
      { key: "defaultPrompt", label: "默认 Prompt", type: "textarea", description: "留空使用内置 Prompt" },
      { key: "defaultSpoiler", label: "默认剧透模式", type: "boolean", default: false },
      { key: "defaultTimeout", label: "默认超时 (ms)", type: "number", min: 5000, max: 300000, default: 120000 },
      { key: "replyMode", label: "回复模式", type: "boolean", default: false, description: "以回复形式发送总结（而非新消息）" },
      { key: "maxOutputLength", label: "最大输出长度", type: "number", min: 500, max: 10000, default: 4000 },
      { key: "linkPreview", label: "链接预览", type: "boolean", default: false },
      { key: "defaultPushTarget", label: "默认推送目标", type: "string", placeholder: "@channel 或 -100xxxxxx", description: "总结结果默认推送到的聊天" },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const db = await JSONFilePreset(DB_PATH, {
          seq: "0", tasks: [],
          aiConfig: {
            providers: {},
            default_provider: "OpenAI", default_prompt: "", default_spoiler: false,
            default_timeout: 120000, reply_mode: false, max_output_length: 4000, link_preview: false,
          },
          defaultPushTarget: "",
        });

        // Initialize default providers if empty
        if (Object.keys(db.data.aiConfig.providers).length === 0) {
          db.data.aiConfig.providers = {
            OpenAI: { name: "OpenAI", base_url: "https://api.openai.com", api_key: "", model: "gpt-4o", type: "auto" },
            Gemini: { name: "Gemini", base_url: "https://generativelanguage.googleapis.com", api_key: "", model: "gemini-2.5-flash", type: "gemini" },
          };
          await db.write();
        }

        const providers = redactApiKeys(db.data.aiConfig.providers);
        const columns = ["name", "base_url", "api_key", "model", "type"];
        const lines = Object.values(providers).map((p: any) => {
          const pp: ParsedProvider = { name: p.name || "", base_url: p.base_url || "", api_key: p.api_key || "••••••••", model: p.model || "", type: p.type || "" };
          return stringifyProvider(pp, columns);
        });

        return {
          providers: lines.join("\n"),
          defaultProvider: db.data.aiConfig.default_provider || "",
          defaultPrompt: db.data.aiConfig.default_prompt || "",
          defaultSpoiler: db.data.aiConfig.default_spoiler ?? false,
          defaultTimeout: db.data.aiConfig.default_timeout ?? 120000,
          replyMode: db.data.aiConfig.reply_mode ?? false,
          maxOutputLength: db.data.aiConfig.max_output_length ?? 4000,
          linkPreview: db.data.aiConfig.link_preview ?? false,
          defaultPushTarget: db.data.defaultPushTarget || "",
        };
      } catch { return {}; }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const db = await JSONFilePreset(DB_PATH, {
        seq: "0", tasks: [],
        aiConfig: {
          providers: {} as Record<string, SumCustomProvider>,
          default_provider: "OpenAI", default_prompt: "", default_spoiler: false,
          default_timeout: 120000, reply_mode: false, max_output_length: 4000, link_preview: false,
        },
        defaultPushTarget: "",
      });

      // Initialize default providers if empty
      if (Object.keys(db.data.aiConfig.providers).length === 0) {
        db.data.aiConfig.providers = {
          OpenAI: { name: "OpenAI", base_url: "https://api.openai.com", api_key: "", model: "gpt-4o", type: "auto" },
          Gemini: { name: "Gemini", base_url: "https://generativelanguage.googleapis.com", api_key: "", model: "gemini-2.5-flash", type: "gemini" },
        };
      }

      if (typeof patch.providers === "string") {
        const lines = patch.providers.split("\n").filter((l) => l.trim());
        const columns = ["name", "base_url", "api_key", "model", "type"];
        const oldProviders: Record<string, SumCustomProvider> = db.data.aiConfig.providers || {};
        // Initialize defaults if empty
        if (Object.keys(oldProviders).length === 0) {
          oldProviders.OpenAI = { name: "OpenAI", base_url: "https://api.openai.com", api_key: "", model: "gpt-4o", type: "auto" };
          oldProviders.Gemini = { name: "Gemini", base_url: "https://generativelanguage.googleapis.com", api_key: "", model: "gemini-2.5-flash", type: "gemini" };
        }
        const newProviders: Record<string, SumCustomProvider> = {};
        for (const line of lines) {
          const parsed = parseProviderLine(line, columns);
          if (!parsed || !parsed.name) continue;
          const old = oldProviders[parsed.name] || {};
          if (parsed.api_key === "••••••••" || !parsed.api_key) parsed.api_key = old.api_key || "";
          newProviders[parsed.name] = {
            name: parsed.name,
            base_url: parsed.base_url || "",
            api_key: parsed.api_key || "",
            model: parsed.model || "",
            type: (parsed.type as "auto" | "chat" | "responses" | "gemini" | "anthropic" | "openai") || "auto",
          };
        }
        db.data.aiConfig.providers = newProviders;
      }

      if (typeof patch.defaultProvider === "string") db.data.aiConfig.default_provider = patch.defaultProvider;
      if (typeof patch.defaultPrompt === "string") db.data.aiConfig.default_prompt = patch.defaultPrompt;
      if (typeof patch.defaultSpoiler === "boolean") db.data.aiConfig.default_spoiler = patch.defaultSpoiler;
      if (typeof patch.defaultTimeout === "number") db.data.aiConfig.default_timeout = patch.defaultTimeout;
      if (typeof patch.replyMode === "boolean") db.data.aiConfig.reply_mode = patch.replyMode;
      if (typeof patch.maxOutputLength === "number") db.data.aiConfig.max_output_length = patch.maxOutputLength;
      if (typeof patch.linkPreview === "boolean") db.data.aiConfig.link_preview = patch.linkPreview;
      if (typeof patch.defaultPushTarget === "string") db.data.defaultPushTarget = patch.defaultPushTarget;

      await db.write();
    },
  });
}

// ============ Agent Plugin (agent.ts) ============
function registerAgentPlugin(): void {
  const AGENT_DIR = path.join(createDirectoryInAssets("agent", ["uai"]));
  const DB_PATH = path.join(AGENT_DIR, "config.json");

  // Type definitions matching agentStore.ts
  interface AgentProvider {
    name: string;
    base_url: string;
    api_key: string;
    model: string;
    type?: "openai" | "gemini" | "anthropic" | "responses" | "deepseek" | "xai" | "custom";
  }

  interface AgentConfig {
    agent_schema_version: number;
    providers: Record<string, AgentProvider>;
    default_provider?: string;
    prompts: Record<string, string>;
    skill_raws: Record<string, string>;
    timeout: number;
    system_timeout: number;
    max_agent_steps: number;
    conversation_context_limit: number;
    zn_name?: string;
    zn_conversations: Record<string, any>;
    zn_workspaces: Record<string, any>;
    icon?: string;
  }

  const DEFAULT_CONFIG: AgentConfig = {
    agent_schema_version: 3,
    providers: {},
    default_provider: undefined,
    prompts: {},
    skill_raws: {},
    timeout: 120000,
    system_timeout: 120000,
    max_agent_steps: 12,
    conversation_context_limit: 20,
    zn_conversations: {},
    zn_workspaces: {},
  };

  function redactAgentKeys(obj: Record<string, AgentProvider>): Record<string, AgentProvider> {
    const copy: Record<string, AgentProvider> = { ...obj };
    for (const k of Object.keys(copy)) {
      if (copy[k].api_key) {
        copy[k] = { ...copy[k], api_key: "••••••••" };
      }
    }
    return copy;
  }

  registerPanelSettings({
    id: "agent",
    title: "Agent 智能体",
    description: "TeleBox-Next 智能体配置：AI 供应商、工作区、对话上下文、权限",
    category: "系统",
    icon: "🤖",
    getSchema: (): PanelSettingField[] => [
      {
        key: "providers",
        label: "AI 供应商配置",
        type: "provider-list",
        description:
          "每行一个供应商，用 | 分隔：Name | Base URL | API Key | Model | Type\n示例：openai | https://api.openai.com | sk-xxx | gpt-4o | openai\nType 可选：openai / gemini / anthropic / responses / deepseek / xai / custom\n留空 Key 表示保持原值不修改。",
        required: true,
        providerColumns: "name|base_url|api_key|model|type",
        providerAddLabel: "+ 添加供应商",
      },
      { key: "defaultProvider", label: "默认供应商", type: "string", placeholder: "openai" },
      { key: "displayName", label: "智能体名称", type: "string", placeholder: "TeleBox-Next", description: "显示在帮助菜单中的名称" },
      { key: "maxSteps", label: "最大执行步数", type: "number", min: 1, max: 100, default: 12, description: "单次运行最大工具调用步数" },
      { key: "modelTimeout", label: "模型超时 (ms)", type: "number", min: 10000, max: 86400000, default: 120000, description: "单次模型请求超时时间" },
      { key: "commandTimeout", label: "命令超时 (ms)", type: "number", min: 10000, max: 86400000, default: 120000, description: "系统命令执行超时时间" },
      { key: "contextLimit", label: "对话上下文条数", type: "number", min: 1, max: 40, default: 20, description: "自动加载的历史消息条数" },
      { key: "icon", label: "状态图标", type: "string", placeholder: "🤖", description: "运行时显示的图标" },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as AgentConfig;
        const providers = redactAgentKeys(raw.providers || {});
        const columns = ["name", "base_url", "api_key", "model", "type"];
        const lines = Object.values(providers).map((p) => {
          const pp = { name: p.name || "", base_url: p.base_url || "", api_key: p.api_key || "••••••••", model: p.model || "", type: p.type || "" };
          return columns.map((col) => pp[col as keyof typeof pp] || "").join(" | ");
        });

        return {
          providers: lines.join("\n"),
          defaultProvider: raw.default_provider || "",
          displayName: raw.zn_name || "",
          maxSteps: raw.max_agent_steps ?? 12,
          modelTimeout: raw.timeout ?? 120000,
          commandTimeout: raw.system_timeout ?? 120000,
          contextLimit: raw.conversation_context_limit ?? 20,
          icon: raw.icon || "🤖",
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: AgentConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as AgentConfig;
      } else {
        db = { ...DEFAULT_CONFIG };
      }

      if (typeof patch.providers === "string") {
        const lines = patch.providers.split("\n").filter((l) => l.trim());
        const columns = ["name", "base_url", "api_key", "model", "type"];
        const existing = db.providers || {};
        const newProviders: Record<string, AgentProvider> = {};
        for (const line of lines) {
          const parts = line.split("|").map((p) => p.trim());
          if (parts.length < columns.length) continue;
          const name = parts[0];
          if (!name) continue;
          const old = existing[name] || {};
          const apiKey = parts[2] === "••••••••" || !parts[2] ? old.api_key || "" : parts[2];
          newProviders[name] = {
            name,
            base_url: parts[1] || "",
            api_key: apiKey,
            model: parts[3] || "",
            type: (parts[4] as AgentProvider["type"]) || "openai",
          };
        }
        db.providers = newProviders;
      }

      if (typeof patch.defaultProvider === "string") db.default_provider = patch.defaultProvider || undefined;
      if (typeof patch.displayName === "string") db.zn_name = patch.displayName || undefined;
      if (typeof patch.maxSteps === "number") db.max_agent_steps = Math.min(100, Math.max(1, patch.maxSteps));
      if (typeof patch.modelTimeout === "number") db.timeout = Math.min(86400000, Math.max(10000, patch.modelTimeout));
      if (typeof patch.commandTimeout === "number") db.system_timeout = Math.min(86400000, Math.max(10000, patch.commandTimeout));
      if (typeof patch.contextLimit === "number") db.conversation_context_limit = Math.min(40, Math.max(1, patch.contextLimit));
      if (typeof patch.icon === "string") db.icon = patch.icon || "🤖";

      // Ensure schema version
      db.agent_schema_version = 3;
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}
export function registerAiPanelProviders(): void {
  registerAiPlugin();
  registerAitcPlugin();
  registerUaiPlugin();
  registerSumPlugin();
  registerAgentPlugin();
}

export function unregisterAiPanelProviders(): void {
  unregisterPanelSettings("ai");
  unregisterPanelSettings("aitc");
  unregisterPanelSettings("uai");
  unregisterPanelSettings("sum");
  unregisterPanelSettings("agent");
}