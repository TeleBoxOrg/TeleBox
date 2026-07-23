/**
 * TeleBox Panel — built-in Panel settings providers for user plugins.
 * These adapt existing plugin config files/APIs to the Panel WebApp.
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

// ============ Helper functions ============
function maskSecret(val: string, visibleChars = 4): string {
  if (!val) return "(未配置)";
  if (val.length <= visibleChars * 2) return "••••••••";
  return `${val.slice(0, visibleChars)}••••••${val.slice(-visibleChars)}`;
}

function redactSecrets(obj: Record<string, any>, secretKeys: string[]): Record<string, any> {
  const copy = { ...obj };
  for (const key of secretKeys) {
    if (copy[key]) {
      copy[key] = "••••••••";
    }
  }
  return copy;
}

// ============ TTS Plugin (tts.ts) ============
function registerTtsPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("tts"), "config.json");

  interface TtsConfig {
    key: string;
    region: string;
    voice: string;
    style?: string;
    rate?: string;
    format: string;
  }

  const DEFAULT_CONFIG: TtsConfig = {
    key: "",
    region: "eastus",
    voice: "zh-CN-XiaoxiaoNeural",
    style: "",
    rate: "1.0",
    format: "audio-48khz-192kbitrate-mono-mp3",
  };

  registerPanelSettings({
    id: "tts",
    title: "TTS 语音合成",
    description: "微软 Azure TTS 配置：Key、Region、语音、风格、语速",
    category: "插件配置",
    icon: "🗣️",
    getSchema: (): PanelSettingField[] => [
      {
        key: "key",
        label: "Azure Speech Key",
        type: "password",
        secret: true,
        description: "从 Azure Portal 获取",
        required: true,
      },
      {
        key: "region",
        label: "Region 区域",
        type: "select",
        options: [
          { value: "eastus", label: "East US (东部美国)" },
          { value: "eastasia", label: "East Asia (东亚)" },
          { value: "southeastasia", label: "Southeast Asia (东南亚)" },
          { value: "northeurope", label: "North Europe (北欧)" },
          { value: "westus2", label: "West US 2 (美国西部 2)" },
          { value: "centralus", label: "Central US (美国中部)" },
        ],
        default: "eastus",
        description: "Azure 语音服务区域",
      },
      {
        key: "voice",
        label: "语音角色",
        type: "string",
        placeholder: "zh-CN-XiaoxiaoNeural",
        default: "zh-CN-XiaoxiaoNeural",
        description: "如 zh-CN-XiaoxiaoNeural, zh-CN-YunyangNeural 等",
      },
      {
        key: "style",
        label: "语音风格",
        type: "string",
        placeholder: "cheerful / sad / chat / clear 等",
        description: "需语音角色支持，如 Xiaoxiao 支持 cheerful, sad, angry, fearful 等",
      },
      {
        key: "rate",
        label: "语速",
        type: "string",
        placeholder: "1.0 (0.5~2.0)",
        default: "1.0",
        description: "0.5(慢) ~ 2.0(快)，默认 1.0",
      },
      {
        key: "format",
        label: "输出格式",
        type: "select",
        options: [
          { value: "audio-48khz-192kbitrate-mono-mp3", label: "MP3 48kHz 192kbps (默认)" },
          { value: "audio-24khz-160kbitrate-mono-mp3", label: "MP3 24kHz 160kbps" },
          { value: "audio-16khz-128kbitrate-mono-mp3", label: "MP3 16kHz 128kbps" },
          { value: "riff-48khz-16bit-mono-pcm", label: "WAV 48kHz 16bit PCM" },
          { value: "riff-24khz-16bit-mono-pcm", label: "WAV 24kHz 16bit PCM" },
          { value: "riff-16khz-16bit-mono-pcm", label: "WAV 16kHz 16bit PCM" },
        ],
        default: "audio-48khz-192kbitrate-mono-mp3",
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as TtsConfig;
        return {
          key: raw.key ? maskSecret(raw.key) : "",
          region: raw.region || "eastus",
          voice: raw.voice || "zh-CN-XiaoxiaoNeural",
          style: raw.style || "",
          rate: raw.rate || "1.0",
          format: raw.format || "audio-48khz-192kbitrate-mono-mp3",
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: TtsConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as TtsConfig;
      } else {
        db = { ...DEFAULT_CONFIG };
      }
      const fields: (keyof TtsConfig)[] = ["key", "region", "voice", "style", "rate", "format"];
      for (const f of fields) {
        if (patch[f] !== undefined) {
          if (f === "key" && String(patch[f]).includes("••••••••")) {
            // keep existing key
          } else {
            (db as any)[f] = patch[f];
          }
        }
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ CheckIn Plugin (checkin.ts) ============
function registerCheckinPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("checkin"), "checkin_config.json");

  interface SignTarget {
    id: string;
    name: string;
    target: string;
    command: string;
    callbackData?: string;
    buttonText?: string;
    enabled: boolean;
  }

  interface CheckInConfig {
    runTime: string;
    logChat: string;
    randomDelay: number;
    lastRunDate: string;
    botToken: string;
    pushChatId: string;
    targets: SignTarget[];
  }

  const DEFAULT_CONFIG: CheckInConfig = {
    runTime: "10:00",
    logChat: "",
    randomDelay: 0,
    lastRunDate: "",
    botToken: "",
    pushChatId: "",
    targets: [],
  };

  registerPanelSettings({
    id: "checkin",
    title: "自动签到",
    description: "定时自动签到任务配置：运行时间、推送设置、签到目标管理",
    category: "插件配置",
    icon: "✅",
    getSchema: (): PanelSettingField[] => [
      {
        key: "runTime",
        label: "运行时间",
        type: "string",
        placeholder: "10:00 (24小时制)",
        default: "10:00",
        description: "每日自动运行时间，格式 HH:MM",
      },
      {
        key: "randomDelay",
        label: "随机延迟 (分钟)",
        type: "number",
        min: 0,
        max: 1440,
        default: 0,
        description: "运行前随机等待 0~N 分钟，避免集中请求",
      },
      {
        key: "logChat",
        label: "日志推送聊天",
        type: "string",
        placeholder: "@channel 或 -100xxxxxx",
        description: "签到结果推送到的群组/频道 (留空不推送)",
      },
      {
        key: "botToken",
        label: "Bot Token (推送用)",
        type: "password",
        secret: true,
        description: "用于推送签到结果的 Bot Token (可选，留空使用 userbot 推送)",
      },
      {
        key: "pushChatId",
        label: "推送 Chat ID",
        type: "string",
        placeholder: "-100xxxxxx",
        description: "Bot 推送目标 Chat ID (配合 botToken 使用)",
      },
      {
        key: "targets",
        label: "签到目标列表",
        type: "textarea",
        description: `JSON 数组，每项: { "id": "唯一标识", "name": "显示名", "target": "@bot或群组", "command": "/start", "callbackData": "回调数据(可选)", "buttonText": "按钮文本(可选)", "enabled": true }`,
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as CheckInConfig;
        return {
          runTime: raw.runTime || "10:00",
          randomDelay: raw.randomDelay ?? 0,
          logChat: raw.logChat || "",
          botToken: raw.botToken ? maskSecret(raw.botToken) : "",
          pushChatId: raw.pushChatId || "",
          targets: JSON.stringify(raw.targets || [], null, 2),
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: CheckInConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as CheckInConfig;
      } else {
        db = { ...DEFAULT_CONFIG };
      }

      if (typeof patch.runTime === "string") db.runTime = patch.runTime;
      if (typeof patch.randomDelay === "number") db.randomDelay = patch.randomDelay;
      if (typeof patch.logChat === "string") db.logChat = patch.logChat;
      if (typeof patch.botToken === "string" && !String(patch.botToken).includes("••••••••")) {
        db.botToken = String(patch.botToken);
      }
      if (typeof patch.pushChatId === "string") db.pushChatId = patch.pushChatId;
      if (typeof patch.targets === "string") {
        try {
          db.targets = JSON.parse(patch.targets) as SignTarget[];
        } catch {
          throw new Error("签到目标 JSON 格式错误");
        }
      }

      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ Music Hub Plugin (music.ts) ============
function registerMusicHubPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("music_hub"), "config.json");

  interface MusicHubConfig {
    defaultSource: string;
    br: string;
    maxResults: number;
    maxUploadBytes: number;
  }

  const DEFAULT_CONFIG: MusicHubConfig = {
    defaultSource: "auto",
    br: "999",
    maxResults: 30,
    maxUploadBytes: 50 * 1024 * 1024,
  };

  const SOURCE_OPTIONS = [
    { value: "auto", label: "自动 (auto)" },
    { value: "netease", label: "网易云音乐" },
    { value: "tencent", label: "QQ 音乐" },
    { value: "kuwo", label: "酷我音乐" },
    { value: "tidal", label: "TIDAL" },
    { value: "qobuz", label: "Qobuz" },
    { value: "joox", label: "JOOX" },
    { value: "bilibili", label: "Bilibili" },
    { value: "apple", label: "Apple Music" },
    { value: "ytmusic", label: "YouTube Music" },
    { value: "spotify", label: "Spotify" },
  ];

  const BR_OPTIONS = [
    { value: "128", label: "128kbps (低)" },
    { value: "320", label: "320kbps (标准)" },
    { value: "999", label: "无损/最高 (999)" },
  ];

  registerPanelSettings({
    id: "music_hub",
    title: "Music Hub 音乐",
    description: "音乐搜索下载配置：默认音源、音质、结果数量、上传大小限制",
    category: "插件配置",
    icon: "🎵",
    getSchema: (): PanelSettingField[] => [
      {
        key: "defaultSource",
        label: "默认音源",
        type: "select",
        options: SOURCE_OPTIONS,
        default: "auto",
      },
      {
        key: "br",
        label: "默认音质",
        type: "select",
        options: BR_OPTIONS,
        default: "999",
      },
      {
        key: "maxResults",
        label: "最大搜索结果数",
        type: "number",
        min: 5,
        max: 100,
        default: 30,
        description: "单次搜索返回的最大结果数",
      },
      {
        key: "maxUploadBytes",
        label: "最大上传大小 (字节)",
        type: "number",
        min: 1024 * 1024,
        max: 2 * 1024 * 1024 * 1024,
        default: 50 * 1024 * 1024,
        description: "Telegram 文件上传限制，默认 50MB",
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as MusicHubConfig;
        return {
          defaultSource: raw.defaultSource || "auto",
          br: raw.br || "999",
          maxResults: raw.maxResults ?? 30,
          maxUploadBytes: raw.maxUploadBytes ?? 50 * 1024 * 1024,
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: MusicHubConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as MusicHubConfig;
      } else {
        db = { ...DEFAULT_CONFIG };
      }
      const fields: (keyof MusicHubConfig)[] = ["defaultSource", "br", "maxResults", "maxUploadBytes"];
      for (const f of fields) {
        if (patch[f] !== undefined) (db as any)[f] = patch[f];
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ Codex Image Plugin (codex_image.ts) ============
function registerCodexImagePlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("codex_image"), "config.json");

  interface CodexImageConfig {
    accessToken: string;
  }

  registerPanelSettings({
    id: "codex_image",
    title: "Codex 图片生成",
    description: "GPT-Image-2 图片生成：配置 Codex Access Token (从 ~/.codex/auth.json 获取)",
    category: "插件配置",
    icon: "🎨",
    getSchema: (): PanelSettingField[] => [
      {
        key: "accessToken",
        label: "Codex Access Token",
        type: "password",
        secret: true,
        description: "从 ~/.codex/auth.json 获取 (格式: {\"OPENAI_API_KEY\": \"sk-...\"})",
        required: true,
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return { accessToken: "" };
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as CodexImageConfig;
        return { accessToken: raw.accessToken ? maskSecret(raw.accessToken) : "" };
      } catch {
        return { accessToken: "" };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: CodexImageConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as CodexImageConfig;
      } else {
        db = { accessToken: "" };
      }
      if (typeof patch.accessToken === "string" && !String(patch.accessToken).includes("••••••••")) {
        db.accessToken = String(patch.accessToken).trim();
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ ZPR Plugin (zpr.ts) ============
function registerZprPlugin(): void {
  const DB_PATH = path.join(createDirectoryInAssets("zpr"), "zpr_config.json");

  interface ZprConfig {
    zpr_proxy_host: string;
  }

  const PROXY_HOSTS = {
    "i.pximg.net": "官方 (i.pximg.net)",
    "i.pixiv.cat": "pixiv.cat",
    "i.pixiv.re": "pixiv.re",
    "i.pixiv.nl": "pixiv.nl",
  };

  const DEFAULT_CONFIG: ZprConfig = {
    zpr_proxy_host: "i.pximg.net",
  };

  registerPanelSettings({
    id: "zpr",
    title: "随机纸片人",
    description: "Lolicon API 图片获取：配置反代服务器",
    category: "插件配置",
    icon: "🎨",
    getSchema: (): PanelSettingField[] => [
      {
        key: "zpr_proxy_host",
        label: "反代服务器",
        type: "select",
        options: Object.entries(PROXY_HOSTS).map(([value, label]) => ({ value, label })),
        default: "i.pximg.net",
        description: "图片下载代理，默认官方 i.pximg.net",
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(DB_PATH)) return { zpr_proxy_host: "i.pximg.net" };
      try {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as ZprConfig;
        return { zpr_proxy_host: raw.zpr_proxy_host || "i.pximg.net" };
      } catch {
        return { zpr_proxy_host: "i.pximg.net" };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: ZprConfig;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as ZprConfig;
      } else {
        db = { ...DEFAULT_CONFIG };
      }
      if (typeof patch.zpr_proxy_host === "string") {
        db.zpr_proxy_host = patch.zpr_proxy_host;
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ DeepWiki Plugin (deepwiki.ts) ============
function registerDeepwikiPlugin(): void {
  const BASE_DIR = createDirectoryInAssets("deepwiki");
  const MAIN_DB = path.join(BASE_DIR, "config.json");
  const CTX_DB = path.join(BASE_DIR, "context.json");

  interface MainDB {
    chats: Record<string, {
      currentTag: string;
      repos: Record<string, { tag: string; repo: string; url: string; addedAt: string }>;
    }>;
    telegraphToken: string;
  }

  interface CtxDB {
    chats: Record<string, {
      contextEnabled?: boolean;
      contextTurns?: Record<string, Array<{ q: string; a: string; at: string }>>;
    }>;
  }

  registerPanelSettings({
    id: "deepwiki",
    title: "DeepWiki MCP",
    description: "DeepWiki 代码问答：Telegraph Token、默认仓库、上下文设置",
    category: "插件配置",
    icon: "📚",
    getSchema: (): PanelSettingField[] => [
      {
        key: "telegraphToken",
        label: "Telegraph Token",
        type: "password",
        secret: true,
        description: "用于发布长文档到 Telegraph (可选，从 https://telegra.ph 获取)",
      },
      {
        key: "defaultRepo",
        label: "默认仓库",
        type: "string",
        placeholder: "owner/repo 或 GitHub URL",
        description: "未指定仓库时使用的默认仓库",
      },
      {
        key: "contextEnabled",
        label: "启用上下文记忆",
        type: "boolean",
        default: false,
        description: "记住对话历史用于多轮问答",
      },
      {
        key: "maxContextTurns",
        label: "最大上下文轮数",
        type: "number",
        min: 1,
        max: 100,
        default: 50,
        description: "每个仓库保留的对话轮数",
      },
    ],
    getValues: async () => {
      try {
        let telegraphToken = "";
        let defaultRepo = "";
        let contextEnabled = false;
        let maxContextTurns = 50;

        if (fs.existsSync(MAIN_DB)) {
          const main = JSON.parse(fs.readFileSync(MAIN_DB, "utf-8")) as MainDB;
          telegraphToken = main.telegraphToken || "";
          // Get first chat's currentTag as default repo hint
          const firstChat = Object.values(main.chats || {})[0];
          if (firstChat?.currentTag) defaultRepo = firstChat.currentTag;
        }
        if (fs.existsSync(CTX_DB)) {
          const ctx = JSON.parse(fs.readFileSync(CTX_DB, "utf-8")) as CtxDB;
          const firstChat = Object.values(ctx.chats || {})[0];
          if (firstChat) {
            contextEnabled = !!firstChat.contextEnabled;
          }
        }

        return {
          telegraphToken: telegraphToken ? maskSecret(telegraphToken) : "",
          defaultRepo,
          contextEnabled,
          maxContextTurns,
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      // Main DB
      let main: MainDB;
      if (fs.existsSync(MAIN_DB)) {
        main = JSON.parse(fs.readFileSync(MAIN_DB, "utf-8")) as MainDB;
      } else {
        main = { chats: {}, telegraphToken: "" };
      }
      if (typeof patch.telegraphToken === "string" && !String(patch.telegraphToken).includes("••••••••")) {
        main.telegraphToken = String(patch.telegraphToken).trim();
      }

      // Context DB
      let ctx: CtxDB;
      if (fs.existsSync(CTX_DB)) {
        ctx = JSON.parse(fs.readFileSync(CTX_DB, "utf-8")) as CtxDB;
      } else {
        ctx = { chats: {} };
      }
      if (typeof patch.contextEnabled === "boolean") {
        for (const chat of Object.values(ctx.chats)) {
          chat.contextEnabled = patch.contextEnabled;
        }
      }

      fs.writeFileSync(MAIN_DB, JSON.stringify(main, null, 2), "utf-8");
      fs.writeFileSync(CTX_DB, JSON.stringify(ctx, null, 2), "utf-8");
    },
  });
}

// ============ ParseHub Plugin (parsehub.ts) ============
function registerParsehubPlugin(): void {
  const STATE_DIR = createDirectoryInAssets("parsehub");
  const STATE_PATH = path.join(STATE_DIR, "state.json");

  interface ParseHubState {
    initialized: boolean;
    ignoredUpToId?: number;
  }

  registerPanelSettings({
    id: "parsehub",
    title: "ParseHub 解析",
    description: "链接解析插件状态：初始化状态、忽略消息 ID",
    category: "插件配置",
    icon: "🔗",
    getSchema: (): PanelSettingField[] => [
      {
        key: "initialized",
        label: "已初始化",
        type: "boolean",
        default: false,
        description: "是否已完成首次启动初始化",
      },
      {
        key: "ignoredUpToId",
        label: "忽略消息 ID",
        type: "number",
        min: 0,
        default: 0,
        description: "启动时忽略的最大消息 ID (避免处理历史消息)",
      },
      {
        key: "resetState",
        label: "重置状态",
        type: "boolean",
        default: false,
        description: "开启后保存将清空状态文件 (需手动关闭)",
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(STATE_PATH)) return { initialized: false, ignoredUpToId: 0, resetState: false };
      try {
        const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as ParseHubState;
        return {
          initialized: raw.initialized ?? false,
          ignoredUpToId: raw.ignoredUpToId ?? 0,
          resetState: false,
        };
      } catch {
        return { initialized: false, ignoredUpToId: 0, resetState: false };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      if (patch.resetState === true) {
        try {
          fs.unlinkSync(STATE_PATH);
          logger.info("[parsehub] State file reset via panel");
        } catch { }
        return;
      }

      let state: ParseHubState;
      if (fs.existsSync(STATE_PATH)) {
        state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as ParseHubState;
      } else {
        state = { initialized: false };
      }
      if (typeof patch.initialized === "boolean") state.initialized = patch.initialized;
      if (typeof patch.ignoredUpToId === "number") state.ignoredUpToId = patch.ignoredUpToId;
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    },
  });
}

// ============ PMCaptcha Plugin (pmcaptcha.ts) ============
function registerPmcaptchaPlugin(): void {
  const BASE_DIR = createDirectoryInAssets("pmcaptcha");
  const CONFIG_PATH = path.join(BASE_DIR, "pmcaptcha_config.json");
  const DATA_PATH = path.join(BASE_DIR, "pmcaptcha_data.json");

  interface PmcaptchaConfig {
    enabled: boolean;
    apiKey: string;
    timeout: number;
    maxRetries: number;
  }

  interface PmcaptchaData {
    stats: Record<string, { solved: number; failed: number; lastUsed: string }>;
  }

  const DEFAULT_CONFIG: PmcaptchaConfig = {
    enabled: true,
    apiKey: "",
    timeout: 30000,
    maxRetries: 3,
  };

  registerPanelSettings({
    id: "pmcaptcha",
    title: "验证码识别",
    description: "PMCaptcha 自动验证码识别配置",
    category: "插件配置",
    icon: "🔐",
    getSchema: (): PanelSettingField[] => [
      {
        key: "enabled",
        label: "启用插件",
        type: "boolean",
        default: true,
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        secret: true,
        description: "PMCaptcha API 密钥",
        required: true,
      },
      {
        key: "timeout",
        label: "超时时间 (ms)",
        type: "number",
        min: 5000,
        max: 120000,
        default: 30000,
      },
      {
        key: "maxRetries",
        label: "最大重试次数",
        type: "number",
        min: 1,
        max: 10,
        default: 3,
      },
    ],
    getValues: async () => {
      if (!fs.existsSync(CONFIG_PATH)) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as PmcaptchaConfig;
        return {
          enabled: raw.enabled ?? true,
          apiKey: raw.apiKey ? maskSecret(raw.apiKey) : "",
          timeout: raw.timeout ?? 30000,
          maxRetries: raw.maxRetries ?? 3,
        };
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      let db: PmcaptchaConfig;
      if (fs.existsSync(CONFIG_PATH)) {
        db = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as PmcaptchaConfig;
      } else {
        db = { ...DEFAULT_CONFIG };
      }
      const fields: (keyof PmcaptchaConfig)[] = ["enabled", "apiKey", "timeout", "maxRetries"];
      for (const f of fields) {
        if (patch[f] !== undefined) {
          if (f === "apiKey" && String(patch[f]).includes("••••••••")) {
            // keep existing
          } else {
            (db as any)[f] = patch[f];
          }
        }
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(db, null, 2), "utf-8");
    },
  });
}

// ============ Exports ============
export function registerUserPluginProviders(): void {
  registerTtsPlugin();
  registerCheckinPlugin();
  registerMusicHubPlugin();
  registerCodexImagePlugin();
  registerZprPlugin();
  registerDeepwikiPlugin();
  registerParsehubPlugin();
  registerPmcaptchaPlugin();
}

export function unregisterUserPluginProviders(): void {
  unregisterPanelSettings("tts");
  unregisterPanelSettings("checkin");
  unregisterPanelSettings("music_hub");
  unregisterPanelSettings("codex_image");
  unregisterPanelSettings("zpr");
  unregisterPanelSettings("deepwiki");
  unregisterPanelSettings("parsehub");
  unregisterPanelSettings("pmcaptcha");
}