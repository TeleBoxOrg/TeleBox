import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import axios from "axios";
import Database from "better-sqlite3";
import path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

const CONFIG_KEYS = {
  API_KEY: "aitc_api_key",
  API_URL: "aitc_api_url",
  MODEL: "aitc_model",
  PROMPT: "aitc_prompt",
  PROMPT_MAP: "aitc_prompts",
  TEMPERATURE: "aitc_temperature",
} as const;

const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.API_URL]: "https://api.openai.com",
  [CONFIG_KEYS.MODEL]: "gpt-4o-mini",
  [CONFIG_KEYS.PROMPT]:
    "You are an expert in Chinese-English translation, translating user input from Chinese to colloquial English. Users can send content that needs to be translated to the assistant, and the assistant will provide the corresponding translation results, ensuring that they conform to Chinese language conventions. You can adjust the tone and style, taking into account the cultural connotations and regional differences of certain words. As a translator, you need to translate the original text into a translation that meets the standards of accuracy and elegance. Only output the translated content!!!",
  [CONFIG_KEYS.PROMPT_MAP]: "{}",
  [CONFIG_KEYS.TEMPERATURE]: "0.2",
};

const RESERVED_PROMPT_ALIASES = new Set([
  "apikey",
  "key",
  "api",
  "model",
  "prompt",
  "temp",
  "temperature",
  "info",
  "spn",
  "url",
  "_set_key",
  "_set_api",
  "_set_model",
  "_set_prompt",
  "_set_temperature",
  "_info",
]);

const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const TEMPERATURE_RANGE_LABEL = `${TEMPERATURE_MIN}-${TEMPERATURE_MAX}`;

const CONFIG_DB_PATH = path.join(
  createDirectoryInAssets("aitc"),
  "aitc_config.db",
);

class ConfigManager {
  private static db: Database.Database | null = null;
  private static initialized = false;

  private static ensureInit(): void {
    if (this.initialized) return;
    try {
      this.db = new Database(CONFIG_DB_PATH);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.initialized = true;
    } catch (error) {
      console.error("aitc plugin failed to init config store", error);
      throw error;
    }
  }

  static get(key: string, fallback?: string): string {
    this.ensureInit();
    try {
      const stmt = this.db!.prepare("SELECT value FROM config WHERE key = ?");
      const row = stmt.get(key) as { value: string } | undefined;
      if (row && typeof row.value === "string") {
        return row.value;
      }
    } catch (error) {
      console.error("aitc plugin failed to read config", error);
    }
    if (fallback !== undefined) return fallback;
    return DEFAULT_CONFIG[key] ?? "";
  }

  static set(key: string, value: string): void {
    this.ensureInit();
    try {
      const stmt = this.db!.prepare(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      );
      stmt.run(key, value);
    } catch (error) {
      console.error("aitc plugin failed to write config", error);
      throw error;
    }
  }

  static getAll(): Record<string, string> {
    this.ensureInit();
    try {
      const stmt = this.db!.prepare("SELECT key, value FROM config");
      const rows = stmt.all() as { key: string; value: string }[];
      const result: Record<string, string> = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    } catch (error) {
      console.error("aitc plugin failed to dump config", error);
      return {};
    }
  }

  static getPromptMap(): Record<string, string> {
    const raw = this.get(
      CONFIG_KEYS.PROMPT_MAP,
      DEFAULT_CONFIG[CONFIG_KEYS.PROMPT_MAP],
    );
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof key === "string" && typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    } catch (error) {
      console.error("aitc plugin failed to parse prompt map", error);
      return {};
    }
  }

  static setPrompt(alias: string, prompt: string): void {
    const map = this.getPromptMap();
    map[alias] = prompt;
    this.set(CONFIG_KEYS.PROMPT_MAP, JSON.stringify(map));
  }

  static close(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
      this.initialized = false;
    }
  }
}

const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[char] || char,
  );

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      switch (entity.toLowerCase()) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "nbsp":
          return " ";
        default:
          return match;
      }
    });

const sanitizePlainText = (text: string): string =>
  decodeHtmlEntities(text)
    // Strip control characters that Telegram may render poorly while preserving common whitespace.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n");

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

const clampTemperature = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value < TEMPERATURE_MIN) return TEMPERATURE_MIN;
  if (value > TEMPERATURE_MAX) return TEMPERATURE_MAX;
  return value;
};

async function handleAitcCommand(msg: Api.Message): Promise<void> {
  const rawMessage = msg.message || "";
  const trimmed = rawMessage.trim();
  const parts = trimmed.split(/\s+/);
  const commandToken = parts.shift() || "";
  const rest = trimmed.slice(commandToken.length).trimStart();
  const subcommand = (parts[0] || "").toLowerCase();

  const replyWith = async (text: string) =>
    msg.edit({
      text,
      parseMode: "html",
      linkPreview: false,
    });

  const replyPlainText = async (text: string) =>
    msg.edit({
      text: sanitizePlainText(text),
      linkPreview: false,
    });

  if (!trimmed) {
    await replyWith(
      "ℹ️ <b>aitc 插件</b>\n\n" +
        "• <code>aitc key ＜API Key＞</code> - 设置API Key\n" +
        "• <code>aitc url ＜地址＞</code> - 自定义API地址\n" +
        "• <code>aitc model ＜模型名＞</code> - 指定模型\n" +
        `• <code>aitc temp ＜${TEMPERATURE_RANGE_LABEL}＞</code> - 调整温度<br>` +
        "• <code>aitc prompt ＜系统Prompt＞</code> - 定义默认Prompt\n" +
        "• <code>aitc spn ＜简称＞ ＜Prompt文本＞</code> - 保存或更新Prompt预设 (set prompt name)\n" +
        "• <code>aitc ＜简称＞ [文本]</code> - 使用预设Prompt处理文本\n" +
        "• <code>aitc [文本]</code> - 使用默认Prompt处理文本\n" +
        "• <code>aitc info</code> - 查看当前配置",
    );
    return;
  }

  const subcommandToken = parts[0] || "";
  const subcommandValue = rest.slice(subcommandToken.length).trimStart();

  switch (subcommand) {
    case "key":
    case "apikey":
    case "_set_key": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供API Key</b>");
        return;
      }
      ConfigManager.set(CONFIG_KEYS.API_KEY, subcommandValue.trim());
      await replyWith("✅ <b>API Key已更新</b>");
      return;
    }
    case "url":
    case "api":
    case "_set_url":
    case "_set_api": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供API地址</b>");
        return;
      }
      ConfigManager.set(
        CONFIG_KEYS.API_URL,
        trimTrailingSlash(subcommandValue.trim()),
      );
      await replyWith("✅ <b>API地址已更新</b>");
      return;
    }
    case "model":
    case "_set_model": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供模型名称</b>");
        return;
      }
      ConfigManager.set(CONFIG_KEYS.MODEL, subcommandValue.trim());
      await replyWith("✅ <b>模型已更新</b>");
      return;
    }
    case "prompt":
    case "_set_prompt": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供Prompt文本</b>");
        return;
      }
      ConfigManager.set(CONFIG_KEYS.PROMPT, subcommandValue);
      await replyWith("✅ <b>Prompt已更新</b>");
      return;
    }
    case "temp":
    case "temperature":
    case "_set_temperature": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供温度数值</b>");
        return;
      }
      const parsed = Number.parseFloat(subcommandValue.trim());
      if (!Number.isFinite(parsed)) {
        await replyWith("❌ <b>无效的温度值，请输入数字</b>");
        return;
      }
      const clamped = clampTemperature(
        parsed,
        Number.parseFloat(DEFAULT_CONFIG[CONFIG_KEYS.TEMPERATURE]),
      );
      if (clamped !== parsed) {
        await replyWith(
          `❌ <b>温度范围需在 ${TEMPERATURE_MIN}-${TEMPERATURE_MAX} 之间</b>`,
        );
        return;
      }
      ConfigManager.set(CONFIG_KEYS.TEMPERATURE, clamped.toString());
      await replyWith("✅ <b>温度已更新</b>");
      return;
    }
    case "spn": {
      const aliasToken = parts[1] || "";
      if (!aliasToken) {
        await replyWith(
          "❌ <b>请提供Prompt简称与内容</b>\n" +
            "用法：<code>aitc spn ＜简称＞ ＜Prompt文本＞</code>",
        );
        return;
      }
      const alias = aliasToken.toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(alias)) {
        await replyWith(
          "❌ <b>Prompt简称仅支持1-32位的字母、数字、下划线或连字符</b>",
        );
        return;
      }
      if (RESERVED_PROMPT_ALIASES.has(alias)) {
        await replyWith("❌ <b>该简称与内置命令冲突，请换一个</b>");
        return;
      }
      const aliasRest = subcommandValue.slice(aliasToken.length).trimStart();
      const promptContent = aliasRest.trim();
      if (!promptContent) {
        await replyWith(
          "❌ <b>请提供Prompt内容</b>\n" +
            "用法：<code>aitc spn ＜简称＞ ＜Prompt文本＞</code>",
        );
        return;
      }
      ConfigManager.setPrompt(alias, promptContent);
      await replyWith(`✅ <b>Prompt「${htmlEscape(aliasToken)}」已保存</b>`);
      return;
    }
    case "info":
    case "_info": {
      const apiUrl = ConfigManager.get(CONFIG_KEYS.API_URL);
      const model = ConfigManager.get(CONFIG_KEYS.MODEL);
      const prompt = ConfigManager.get(CONFIG_KEYS.PROMPT);
      const hasKey = !!ConfigManager.get(CONFIG_KEYS.API_KEY, "");
      const temperature = ConfigManager.get(
        CONFIG_KEYS.TEMPERATURE,
        DEFAULT_CONFIG[CONFIG_KEYS.TEMPERATURE],
      );
      const promptAliasMap = ConfigManager.getPromptMap();
      const promptAliases = Object.keys(promptAliasMap).sort();
      const promptAliasText = promptAliases.length
        ? promptAliases
            .map((alias) => `<code>${htmlEscape(alias)}</code>`)
            .join("、")
        : "(未保存)";
      await replyWith(
        `🔧 <b>当前配置</b><br><br>` +
          `• API URL：<code>${htmlEscape(apiUrl)}</code><br>` +
          `• 模型：<code>${htmlEscape(model)}</code><br>` +
          `• 温度：<code>${htmlEscape(temperature)}</code><br>` +
          `• 默认Prompt：${htmlEscape(prompt || "(未设置)")}<br>` +
          `• Prompt预设：${promptAliasText}<br>` +
          `• API Key：${hasKey ? "已配置" : "未配置"}`,
      );
      return;
    }
    default: {
      if (subcommandToken.startsWith("_")) {
        await replyWith("❌ <b>未知配置命令</b>");
        return;
      }
    }
  }

  const promptMap = ConfigManager.getPromptMap();
  let userInput = rest;
  let systemPrompt: string | null = null;

  if (subcommandToken) {
    const aliasPrompt = promptMap[subcommandToken.toLowerCase()];
    if (aliasPrompt) {
      systemPrompt = aliasPrompt;
      userInput = rest.slice(subcommandToken.length).trimStart();
    }
  }

  if (!userInput) {
    try {
      const reply = await safeGetReplyMessage(msg);
      const replyText =
        reply?.message || ("text" in (reply || {}) ? (reply as any).text : "");
      if (typeof replyText === "string") {
        userInput = replyText.trim();
      }
    } catch (error) {
      console.error("aitc plugin failed to read reply", error);
    }
  }

  if (systemPrompt === null) {
    systemPrompt =
      ConfigManager.get(CONFIG_KEYS.PROMPT) ||
      DEFAULT_CONFIG[CONFIG_KEYS.PROMPT];
  }

  if (!userInput) {
    await replyWith("❌ <b>请在命令后提供文本或回复一条消息</b>");
    return;
  }

  const apiKey = ConfigManager.get(CONFIG_KEYS.API_KEY, "");
  if (!apiKey) {
    await replyWith(
      "❌ <b>未配置API Key</b>\n请使用 <code>aitc _set_key ＜OpenAI Key＞</code> 设置后再试",
    );
    return;
  }

  const apiUrl = trimTrailingSlash(
    ConfigManager.get(CONFIG_KEYS.API_URL) ||
      DEFAULT_CONFIG[CONFIG_KEYS.API_URL],
  );
  const model =
    ConfigManager.get(CONFIG_KEYS.MODEL) || DEFAULT_CONFIG[CONFIG_KEYS.MODEL];
  const temperature = clampTemperature(
    Number.parseFloat(
      ConfigManager.get(
        CONFIG_KEYS.TEMPERATURE,
        DEFAULT_CONFIG[CONFIG_KEYS.TEMPERATURE],
      ),
    ),
    Number.parseFloat(DEFAULT_CONFIG[CONFIG_KEYS.TEMPERATURE]),
  );

  await replyWith("⏳ <b>正在请求...</b>");

  try {
    const response = await axios.post(
      `${apiUrl}/v1/chat/completions`,
      {
        model,
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: userInput },
        ],
        temperature,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("API 返回空结果");
    }

    const translated = content.trim();
    await replyPlainText(translated);
  } catch (error: any) {
    console.error("aitc plugin openai error", error);
    let message = "请求失败，请稍后重试";
    if (error.response?.data?.error?.message) {
      message = error.response.data.error.message;
    } else if (error.response?.status) {
      message = `API 返回状态 ${error.response.status}`;
    } else if (error.message) {
      message = error.message;
    }
    if (message.length > 200) {
      message = message.slice(0, 200) + "...";
    }
    await replyWith(`❌ <b>调用失败：</b>${htmlEscape(message)}`);
  }
}

class AitcPlugin extends Plugin {
  description: string = `
自定义 Prompt 的 AI 转写插件：
- aitc url ＜地址＞ - 自定义API地址（兼容OpenAI SDK，默认OpenAI）
- aitc key ＜API Key＞ - 设置API Key
- aitc model ＜模型名＞ - 指定模型（默认gpt-4o-mini）
- aitc temp ＜${TEMPERATURE_RANGE_LABEL}＞ - 调整模型温度（默认0.2）
- aitc prompt ＜默认Prompt＞ - 设置默认Prompt（默认转写为英文）
- aitc spn ＜Prompt简称＞ ＜Prompt内容＞ - 保存或更新Prompt预设
- aitc ＜Prompt简称＞ [文本] - 使用预设Prompt处理文本
- aitc [文本] - 使用默认Prompt处理文本
- aitc info - 查看当前配置
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    aitc: handleAitcCommand,
  };

  cleanup(): void {
    ConfigManager.close();
  }
}

export default new AitcPlugin();
