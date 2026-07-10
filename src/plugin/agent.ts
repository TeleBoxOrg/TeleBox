import { Plugin } from "@utils/pluginBase";

import import_fs4 = require("fs");
import import_path4 = require("path");
import import_child_process2 = require("child_process");
import import_pluginManager3 = require("@utils/pluginManager");
import import_globalClient3 = require("@utils/globalClient");

// plugins/agent/provider.ts
import import_axios = require("axios");
var MAX_OUTPUT_TOKENS = 8192;
var ANTHROPIC_VERSION = "2023-06-01";
function trimBase(url) {
  return String(url || "").trim().replace(/\/+$/g, "");
}
function stripKnownEndpoint(url) {
  let base = trimBase(String(url || "").split(/[?#]/, 1)[0] || "");
  const patterns = [
    /\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/i,
    /\/(?:chat\/completions|completions|responses|messages)$/i
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = trimBase(base.replace(pattern, ""));
      if (next !== base) {
        base = next;
        changed = true;
      }
    }
  }
  return base;
}
function hasVersionPath(url) {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(url);
  }
}
function endpoint(provider, kind) {
  const base = stripKnownEndpoint(provider.base_url);
  if (kind === "gemini") {
    const model = encodeURIComponent(provider.model.replace(/^models\//, ""));
    return hasVersionPath(base) ? `${base}/models/${model}:generateContent` : `${base}/v1beta/models/${model}:generateContent`;
  }
  if (kind === "anthropic") {
    if (/\/anthropic$/i.test(base)) return `${base}/v1/messages`;
    return hasVersionPath(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  if (kind === "responses") {
    return hasVersionPath(base) ? `${base}/responses` : `${base}/v1/responses`;
  }
  return hasVersionPath(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}
function providerInterface(provider) {
  const explicit = String(provider.api_interface || "").trim().toLowerCase();
  if (explicit) return explicit;
  const hint = `${provider.name} ${provider.base_url}`.toLowerCase();
  if (hint.includes("anthropic") || hint.includes("claude")) return "anthropic";
  return "openai";
}
function requestAuth(provider) {
  const headers = { "Content-Type": "application/json" };
  const params = {};
  if (provider.type === "gemini") {
    if (provider.auth_method === "api_key_header") headers["x-goog-api-key"] = provider.api_key;
    else params.key = provider.api_key;
    return { headers, params };
  }
  if (provider.auth_method === "api_key_header") headers["X-API-Key"] = provider.api_key;
  else if (provider.auth_method === "query_param") params.key = provider.api_key;
  else headers.Authorization = `Bearer ${provider.api_key}`;
  return { headers, params };
}
function systemPrompt(messages) {
  return messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
}
function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: text };
  }
}
function usageFromOpenAI(data) {
  const usage = data?.usage;
  if (!usage) return void 0;
  return {
    prompt: usage.prompt_tokens ?? usage.input_tokens,
    completion: usage.completion_tokens ?? usage.output_tokens,
    total: usage.total_tokens
  };
}
function usageFromGemini(data) {
  const usage = data?.usageMetadata;
  if (!usage) return void 0;
  return {
    prompt: usage.promptTokenCount,
    completion: usage.candidatesTokenCount,
    total: usage.totalTokenCount
  };
}
function usageFromAnthropic(data) {
  const usage = data?.usage;
  if (!usage) return void 0;
  const prompt = usage.input_tokens;
  const completion = usage.output_tokens;
  return {
    prompt,
    completion,
    total: typeof prompt === "number" || typeof completion === "number" ? (prompt || 0) + (completion || 0) : void 0
  };
}
function apiError(data) {
  const error = data?.error;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return "";
}
function openAIMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(
    (part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : ""
  ).join("\n").trim();
}
function openAITools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}
function toOpenAIChatMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: message.content
      };
    }
    const base = { role: message.role };
    if (message.images?.length && message.role === "user") {
      base.content = [
        { type: "text", text: message.content },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` }
        }))
      ];
    } else {
      base.content = message.content || null;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }));
    }
    return base;
  });
}
async function callOpenAIChat(provider, messages, tools, timeoutMs) {
  const auth = requestAuth(provider);
  const response = await import_axios.post(
    endpoint(provider, "chat"),
    {
      model: provider.model,
      messages: toOpenAIChatMessages(messages),
      ...tools.length ? { tools: openAITools(tools), tool_choice: "auto" } : {},
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS
    },
    { timeout: timeoutMs, headers: auth.headers, params: auth.params }
  );
  const error = apiError(response.data);
  if (error) throw new Error(error);
  const message = response.data?.choices?.[0]?.message;
  if (!message) throw new Error("\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u6D88\u606F");
  const calls = (message.tool_calls || []).map((call, index) => ({
    id: String(call.id || `call_${Date.now()}_${index}`),
    name: String(call.function?.name || call.name || ""),
    arguments: parseArguments(call.function?.arguments ?? call.arguments)
  })).filter((call) => call.name);
  return {
    text: openAIMessageText(message.content),
    toolCalls: calls,
    usage: usageFromOpenAI(response.data)
  };
}
function toResponsesInput(messages) {
  const items = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content
      });
      continue;
    }
    const contentType = message.role === "assistant" ? "output_text" : "input_text";
    const content = [
      { type: contentType, text: message.content || "" }
    ];
    if (message.role === "user") {
      content.push(
        ...(message.images || []).map((image) => ({
          type: "input_image",
          image_url: `data:${image.mimeType};base64,${image.base64}`
        }))
      );
    }
    if (message.content || message.images?.length) {
      items.push({ type: "message", role: message.role, content });
    }
    for (const call of message.toolCalls || []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments)
      });
    }
  }
  return items;
}
async function callResponses(provider, messages, tools, timeoutMs) {
  const auth = requestAuth(provider);
  const response = await import_axios.post(
    endpoint(provider, "responses"),
    {
      model: provider.model,
      instructions: systemPrompt(messages),
      input: toResponsesInput(messages),
      ...tools.length ? {
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false
        })),
        tool_choice: "auto"
      } : {},
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false
    },
    { timeout: timeoutMs, headers: auth.headers, params: auth.params }
  );
  const error = apiError(response.data);
  if (error) throw new Error(error);
  const text = [];
  const calls = [];
  for (const item of response.data?.output || []) {
    if (item.type === "function_call") {
      calls.push({
        id: String(item.call_id || item.id || `call_${Date.now()}_${calls.length}`),
        name: String(item.name || ""),
        arguments: parseArguments(item.arguments)
      });
      continue;
    }
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" || part.type === "text") {
          text.push(String(part.text || ""));
        }
      }
    }
  }
  if (!text.length && typeof response.data?.output_text === "string") {
    text.push(response.data.output_text);
  }
  return {
    text: text.join("\n").trim(),
    toolCalls: calls.filter((call) => call.name),
    usage: usageFromOpenAI(response.data)
  };
}
function anthropicContent(message) {
  const blocks = [];
  if (message.role === "user") {
    for (const image of message.images || []) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.base64 }
      });
    }
  }
  if (message.content) blocks.push({ type: "text", text: message.content });
  if (message.role === "assistant") {
    for (const call of message.toolCalls || []) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
  }
  return blocks.length ? blocks : "";
}
function toAnthropicMessages(messages) {
  const output = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const blocks = [];
      let messageIndex = index;
      while (messageIndex < messages.length && messages[messageIndex].role === "tool") {
        const toolMessage = messages[messageIndex];
        blocks.push({
          type: "tool_result",
          tool_use_id: toolMessage.toolCallId,
          content: toolMessage.content
        });
        messageIndex += 1;
      }
      output.push({ role: "user", content: blocks });
      index = messageIndex - 1;
      continue;
    }
    output.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: anthropicContent(message)
    });
  }
  return output;
}
async function callAnthropic(provider, messages, tools, timeoutMs) {
  const response = await import_axios.post(
    endpoint(provider, "anthropic"),
    {
      model: provider.model,
      system: systemPrompt(messages),
      messages: toAnthropicMessages(messages),
      ...tools.length ? {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        }))
      } : {},
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2
    },
    {
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.api_key,
        "anthropic-version": ANTHROPIC_VERSION
      }
    }
  );
  const error = apiError(response.data);
  if (error) throw new Error(error);
  const text = [];
  const calls = [];
  for (const part of response.data?.content || []) {
    if (part.type === "text") text.push(String(part.text || ""));
    if (part.type === "tool_use") {
      calls.push({
        id: String(part.id || `call_${Date.now()}_${calls.length}`),
        name: String(part.name || ""),
        arguments: parseArguments(part.input)
      });
    }
  }
  return {
    text: text.join("\n").trim(),
    toolCalls: calls.filter((call) => call.name),
    usage: usageFromAnthropic(response.data)
  };
}
function toGeminiContents(messages) {
  const contents = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const parts2 = [];
      let messageIndex = index;
      while (messageIndex < messages.length && messages[messageIndex].role === "tool") {
        const toolMessage = messages[messageIndex];
        parts2.push({
          functionResponse: {
            name: toolMessage.toolName,
            response: { result: toolMessage.content }
          }
        });
        messageIndex += 1;
      }
      contents.push({ role: "user", parts: parts2 });
      index = messageIndex - 1;
      continue;
    }
    const parts = [];
    if (message.content) parts.push({ text: message.content });
    if (message.role === "user") {
      parts.push(
        ...(message.images || []).map((image) => ({
          inlineData: { mimeType: image.mimeType, data: image.base64 }
        }))
      );
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
    }
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}
function toGeminiSchema(value) {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== "object") return value;
  const record = value;
  const output = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "additionalProperties") continue;
    if (key === "type" && typeof item === "string") {
      output.type = item.toUpperCase();
      continue;
    }
    output[key] = toGeminiSchema(item);
  }
  return output;
}
async function callGemini(provider, messages, tools, timeoutMs) {
  const auth = requestAuth(provider);
  const response = await import_axios.post(
    endpoint(provider, "gemini"),
    {
      systemInstruction: { parts: [{ text: systemPrompt(messages) }] },
      contents: toGeminiContents(messages),
      ...tools.length ? {
        tools: [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: toGeminiSchema(tool.parameters)
            }))
          }
        ],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } }
      } : {},
      generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS }
    },
    { timeout: timeoutMs, headers: auth.headers, params: auth.params }
  );
  const error = apiError(response.data);
  if (error) throw new Error(error);
  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const text = [];
  const calls = [];
  for (const part of parts) {
    if (typeof part.text === "string") text.push(part.text);
    if (part.functionCall?.name) {
      calls.push({
        id: `gemini_${Date.now()}_${calls.length}`,
        name: String(part.functionCall.name),
        arguments: parseArguments(part.functionCall.args)
      });
    }
  }
  return {
    text: text.join("\n").trim(),
    toolCalls: calls,
    usage: usageFromGemini(response.data)
  };
}
async function callModel(provider, messages, tools, timeoutMs) {
  const invoke = async (currentMessages, currentTools) => {
    if (provider.type === "gemini") {
      return await callGemini(provider, currentMessages, currentTools, timeoutMs);
    }
    const api = providerInterface(provider);
    if (api.includes("anthropic")) {
      return await callAnthropic(provider, currentMessages, currentTools, timeoutMs);
    }
    if (api.includes("responses")) {
      return await callResponses(provider, currentMessages, currentTools, timeoutMs);
    }
    return await callOpenAIChat(provider, currentMessages, currentTools, timeoutMs);
  };
  try {
    return await withTransientRetry(() => invoke(messages, tools));
  } catch (error) {
    const status = import_axios.isAxiosError(error) ? error.response?.status : void 0;
    const detail = formatProviderError(error);
    const toolCompatibilityError = tools.length > 0 && [400, 404, 422].includes(status || 0) && /(tool|function|schema|unknown field|unsupported|not support)/i.test(detail);
    if (!toolCompatibilityError) throw error;
    const fallbackMessages = messages.map(
      (message, index) => index === 0 && message.role === "system" ? {
        ...message,
        content: [
          message.content,
          "[\u63A5\u53E3\u517C\u5BB9\u6A21\u5F0F] \u5F53\u524D\u6A21\u578B\u63A5\u53E3\u62D2\u7EDD\u539F\u751F\u5DE5\u5177\u5B9A\u4E49\u3002\u9700\u8981\u6267\u884C\u5DE5\u5177\u65F6\uFF0C\u53EA\u8FD4\u56DE\u4E00\u4E2A\u4E25\u683C JSON\uFF1A",
          '{"tool":"\u5DE5\u5177\u540D","arguments":{"\u53C2\u6570":"\u503C"}}',
          "\u4E0D\u8981\u7528\u81EA\u7136\u8BED\u8A00\u58F0\u79F0\u5DE5\u5177\u5DF2\u7ECF\u6267\u884C\u3002"
        ].join("\n")
      } : message
    );
    return await withTransientRetry(() => invoke(fallbackMessages, []));
  }
}
function isTransientError(error) {
  if (import_axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status && (status >= 500 || status === 429)) return true;
    if (error.code && ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(error.code)) return true;
    if (/timeout|network|econnreset|socket hang up/i.test(error.message || "")) return true;
    return false;
  }
  const code = error?.code || "";
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) return true;
  if (/timeout|network/i.test(error?.message || "")) return true;
  return false;
}
async function withTransientRetry(task, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientError(error)) throw error;
      const delay = Math.min(8e3, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
function addUsage(total, next) {
  if (!total && !next) return void 0;
  return {
    prompt: typeof total?.prompt === "number" || typeof next?.prompt === "number" ? (total?.prompt || 0) + (next?.prompt || 0) : void 0,
    completion: typeof total?.completion === "number" || typeof next?.completion === "number" ? (total?.completion || 0) + (next?.completion || 0) : void 0,
    total: typeof total?.total === "number" || typeof next?.total === "number" ? (total?.total || 0) + (next?.total || 0) : void 0
  };
}
function formatProviderError(error) {
  if (import_axios.isAxiosError(error)) {
    const data = error.response?.data;
    const message = apiError(data) || data?.message || error.message;
    const status = error.response?.status;
    return [status ? `HTTP ${status}` : "", message].filter(Boolean).join(": ");
  }
  return error instanceof Error ? error.message : String(error);
}

// plugins/agent/tools.ts
import import_fs = require("fs");
import import_path = require("path");
import import_child_process = require("child_process");
import import_globalClient = require("@utils/globalClient");
import import_pluginManager = require("@utils/pluginManager");
var MAX_TOOL_OUTPUT = 2e4;
var MAX_TEXT_READ = 2 * 1024 * 1024;
var MAX_WRITE_SIZE = 4 * 1024 * 1024;
var MAX_SEND_SIZE = 50 * 1024 * 1024;
var MAX_LIST_ENTRIES = 300;
var MAX_TOOL_CALLS_PER_TURN = 8;
var BLOCKED_PLUGIN_COMMANDS = /* @__PURE__ */ new Set(["agent", "plan", "sysagent", "sysplan", "ai", "exec"]);
var OBJECT_SCHEMA = "object";
function schema(properties, required = []) {
  return {
    type: OBJECT_SCHEMA,
    properties,
    required,
    additionalProperties: false
  };
}
var TOOL_DEFINITIONS = [
  {
    name: "update_plan",
    description: "\u521B\u5EFA\u6216\u66F4\u65B0\u6267\u884C\u8BA1\u5212\u3002\u9002\u7528\u4E8E\u591A\u6B65\u9AA4\u6216\u590D\u6742\u4EFB\u52A1\uFF1A\u5148\u5217\u51FA\u6240\u6709\u6B65\u9AA4\uFF0C\u6267\u884C\u65F6\u9010\u6B65\u628A\u5F53\u524D\u6B65\u9AA4\u6807\u8BB0 in_progress\u3001\u5B8C\u6210\u540E\u6807\u8BB0 completed\u3002\u6BCF\u6B21\u53EA\u80FD\u6709\u4E00\u4E2A in_progress\u3002\u8BA1\u5212\u662F\u8FDB\u5EA6\u8BB0\u5F55\uFF0C\u4E0D\u662F\u6700\u7EC8\u7ED3\u679C\u3002",
    parameters: schema(
      {
        explanation: { type: "string", description: "\u4E3A\u4EC0\u4E48\u8FD9\u6837\u8C03\u6574\u8BA1\u5212\uFF0C\u53EF\u7701\u7565" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: schema(
            {
              step: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"]
              }
            },
            ["step", "status"]
          )
        }
      },
      ["items"]
    )
  },
  {
    name: "list_files",
    description: "\u5217\u51FA\u76EE\u5F55\u4E0B\u7684\u6587\u4EF6\u4E0E\u5B50\u76EE\u5F55\uFF0C\u5FEB\u901F\u4E86\u89E3\u9879\u76EE\u7ED3\u6784\u3002\u9700\u8981\u627E\u6587\u4EF6\u4F4D\u7F6E\u6216\u6574\u4F53\u5E03\u5C40\u65F6\u4F18\u5148\u7528\u5B83\uFF1B\u9700\u8981\u6587\u672C\u5339\u914D\u7528 search_files\u3002",
    parameters: schema({
      path: { type: "string", description: "\u76EE\u5F55\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u5F53\u524D\u6839\u76EE\u5F55" },
      recursive: { type: "boolean", description: "\u662F\u5426\u9012\u5F52\uFF0C\u9ED8\u8BA4 false" },
      max_entries: { type: "integer", minimum: 1, maximum: MAX_LIST_ENTRIES }
    })
  },
  {
    name: "read_file",
    description: "\u8BFB\u53D6\u6587\u672C\u6587\u4EF6\u7684\u5185\u5BB9\uFF0C\u53EF\u7528 start_line/end_line \u622A\u53D6\u6307\u5B9A\u884C\u8303\u56F4\u3002\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\u524D\u5FC5\u987B\u5148\u8BFB\u53D6\u5B83\uFF1B\u5927\u6587\u4EF6\u53EA\u8BFB\u9700\u8981\u7684\u90E8\u5206\u3002",
    parameters: schema(
      {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 }
      },
      ["path"]
    )
  },
  {
    name: "search_files",
    description: "\u7528 ripgrep \u5728\u6587\u4EF6\u4E2D\u641C\u7D22\u6587\u672C\u6216\u6B63\u5219\u8868\u8FBE\u5F0F\uFF0C\u8FD4\u56DE\u6587\u4EF6\u540D:\u884C\u53F7:\u5339\u914D\u884C\u3002\u627E\u4EE3\u7801\u3001\u5B9A\u4E49\u3001\u9519\u8BEF\u4FE1\u606F\u65F6\u4E3B\u7528\u5B83\uFF1B\u7528 glob \u9650\u5B9A\u6587\u4EF6\u7C7B\u578B\u3001\u7528 fixed_string \u505A\u7EAF\u6587\u672C\u5339\u914D\u3002",
    parameters: schema(
      {
        query: { type: "string" },
        path: { type: "string", description: "\u641C\u7D22\u76EE\u5F55\uFF0C\u9ED8\u8BA4\u5F53\u524D\u6839\u76EE\u5F55" },
        glob: { type: "string", description: "\u53EF\u9009 glob\uFF0C\u4F8B\u5982 *.ts \u6216 src/**" },
        fixed_string: { type: "boolean", description: "\u6309\u7EAF\u6587\u672C\u641C\u7D22\uFF0C\u9ED8\u8BA4 false" },
        max_results: { type: "integer", minimum: 1, maximum: 300 }
      },
      ["query"]
    )
  },
  {
    name: "write_file",
    description: "\u521B\u5EFA\u65B0\u6587\u4EF6\u6216\u5B8C\u6574\u91CD\u5199\u6587\u4EF6\u3002\u9ED8\u8BA4 overwrite \u4F1A\u8986\u76D6\u539F\u6587\u4EF6\uFF1B\u4FEE\u6539\u5DF2\u6709\u6587\u4EF6\u524D\u5FC5\u987B\u5148 read_file\uFF0C\u5C0F\u8303\u56F4\u6539\u52A8\u7528 replace_text \u66F4\u5B89\u5168\u3002",
    parameters: schema(
      {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"] }
      },
      ["path", "content"]
    )
  },
  {
    name: "replace_text",
    description: "\u5728\u6587\u4EF6\u4E2D\u7CBE\u786E\u66FF\u6362\u4E00\u6BB5\u6587\u672C\uFF0C\u9002\u5408\u5C0F\u8303\u56F4\u7F16\u8F91\u3002old_text \u5FC5\u987B\u4E0E\u6587\u4EF6\u4E2D\u7684\u5185\u5BB9\u5B8C\u5168\u4E00\u81F4\uFF08\u6CE8\u610F\u884C\u5C3E\u6362\u884C\u7B26\uFF09\uFF1B\u9ED8\u8BA4\u53EA\u66FF\u6362\u7B2C\u4E00\u5904\uFF0C\u8BBE replace_all \u53EF\u5168\u90E8\u66FF\u6362\u3002",
    parameters: schema(
      {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" }
      },
      ["path", "old_text", "new_text"]
    )
  },
  {
    name: "delete_file",
    description: "\u5220\u9664\u5355\u4E2A\u6587\u4EF6\u3002\u4EE5\u5220\u9664\u6587\u4EF6\u3001\u4E0D\u80FD\u5220\u76EE\u5F55\uFF1B\u8DEF\u5F84\u53D7\u5DE5\u4F5C\u533A\u9650\u5236\u3002\u5220\u9664\u524D\u786E\u8BA4\u5185\u5BB9\u4E0D\u518D\u9700\u8981\u3002",
    parameters: schema({ path: { type: "string" } }, ["path"])
  },
  {
    name: "run_command",
    description: "\u8FD0\u884C\u7EC8\u7AEF\u547D\u4EE4\uFF0C\u8FD4\u56DE exit_code\u3001stdout\u3001stderr\u3002\u7528\u4E8E\u6784\u5EFA\u3001\u6D4B\u8BD5\u3001\u68C0\u67E5\u3001\u4EE3\u7801\u683C\u5F0F\u5316\u7B49\u5FC5\u8981\u7684\u7EC8\u7AEF\u64CD\u4F5C\u3002\u547D\u4EE4\u5931\u8D25\u65F6\u8BFB stderr \u5B9A\u4F4D\u539F\u56E0\uFF1B\u4E0D\u80FD\u4F2A\u9020\u7ED3\u679C\u3002",
    parameters: schema(
      {
        command: { type: "string" },
        cwd: { type: "string", description: "\u5DE5\u4F5C\u76EE\u5F55\uFF1BTeleBox \u6A21\u5F0F\u4E0B\u5FC5\u987B\u4F4D\u4E8E\u9879\u76EE\u5185" },
        timeout_ms: { type: "integer", minimum: 1e3, maximum: 864e5 }
      },
      ["command"]
    )
  },
  {
    name: "list_plugins",
    description: "\u5217\u51FA\u5F53\u524D\u53EF\u7528\u7684 TeleBox \u63D2\u4EF6\u547D\u4EE4\uFF08\u4E0D\u542B\u88AB\u5C4F\u853D\u7684\u547D\u4EE4\uFF09\u3002\u60F3\u7528\u67D0\u4E2A\u80FD\u529B\u4F46\u4E0D\u786E\u5B9A\u547D\u4EE4\u540D\u65F6\u5148\u8C03\u7528\u5B83\uFF0C\u518D\u7528 run_plugin \u6267\u884C\u3002",
    parameters: schema({})
  },
  {
    name: "run_plugin",
    description: "\u8C03\u7528\u4E00\u4E2A TeleBox \u63D2\u4EF6\u547D\u4EE4\u3002\u3002command \u4E0D\u5E26\u524D\u7F00\uFF0C\u4F8B\u5982 `ping` \u6216 `ssr status`\uFF1B\u53EF\u7528 run_plugin \u8C03\u7528\u7684\u80FD\u529B\u8986\u76D6\u539F\u751F\u5DE5\u5177\u4E4B\u5916\u7684\u4E1A\u52A1\u3002\u7981\u6B62\u9012\u5F52\u8C03\u7528 agent/sysagent/ai/exec\u3002",
    parameters: schema({ command: { type: "string" } }, ["command"])
  },
  {
    name: "send_file",
    description: "\u628A\u5DE5\u4F5C\u533A\u4E2D\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u53D1\u9001\u5230\u5F53\u524D Telegram \u5BF9\u8BDD\u3002\u53EA\u80FD\u53D1\u9001\u5DF2\u751F\u6210\u7684\u6587\u4EF6\uFF1B\u6210\u529F\u8FD4\u56DE\u540E\u624D\u80FD\u544A\u77E5\u7528\u6237\u6587\u4EF6\u5DF2\u53D1\u9001\u3002",
    parameters: schema(
      {
        path: { type: "string" },
        caption: { type: "string" }
      },
      ["path"]
    )
  }
];
function truncate(text, max = MAX_TOOL_OUTPUT) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max)}
\u2026\uFF08\u5DE5\u5177\u8F93\u51FA\u5DF2\u622A\u65AD\uFF09`;
}
function asString(value, fallback = "") {
  return typeof value === "string" ? value : value === void 0 ? fallback : String(value);
}
function asInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}
function within(root, target) {
  const relative = import_path.relative(import_path.resolve(root), import_path.resolve(target));
  return relative === "" || !relative.startsWith("..") && !import_path.isAbsolute(relative);
}
function defaultRoot(context) {
  return context.scope === "telebox" ? context.projectRoot : context.workspace.dir;
}
function resolveAgentPath(context, rawPath, fallback = ".") {
  let requested = asString(rawPath, fallback).trim().replace(/^['"]|['"]$/g, "") || fallback;
  let base = defaultRoot(context);
  if (/^(?:\$workspace|workspace:)(?:[\\/]|$)/i.test(requested)) {
    requested = requested.replace(/^(?:\$workspace|workspace:)[\\/]?/i, "");
    base = context.workspace.dir;
  } else if (/^(?:\$project|project:)(?:[\\/]|$)/i.test(requested)) {
    requested = requested.replace(/^(?:\$project|project:)[\\/]?/i, "");
    base = context.projectRoot;
  }
  const resolved = import_path.resolve(base, requested || ".");
  if (context.scope === "telebox" && !within(context.projectRoot, resolved) && !within(context.workspace.dir, resolved)) {
    throw new Error("TeleBox \u667A\u80FD\u4F53\u4E0D\u80FD\u8BBF\u95EE\u9879\u76EE\u76EE\u5F55\u4EE5\u5916\u7684\u8DEF\u5F84\uFF1B\u8BF7\u4F7F\u7528 .sysagent \u6267\u884C\u7CFB\u7EDF\u7EA7\u4EFB\u52A1");
  }
  return resolved;
}
function relativeDisplay(context, target) {
  if (within(context.projectRoot, target)) {
    return import_path.relative(context.projectRoot, target) || ".";
  }
  if (within(context.workspace.dir, target)) {
    return `$workspace/${import_path.relative(context.workspace.dir, target) || "."}`;
  }
  return target;
}
async function collectFiles(context, root, recursive, limit) {
  const output = [];
  const visit = async (directory) => {
    if (output.length >= limit) return;
    const entries = await import_fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (output.length >= limit) break;
      const absolute = import_path.join(directory, entry.name);
      if (entry.isDirectory()) {
        output.push(`${relativeDisplay(context, absolute)}/`);
        if (recursive) await visit(absolute);
      } else if (entry.isFile()) {
        const stat = await import_fs.promises.stat(absolute);
        output.push(`${relativeDisplay(context, absolute)} (${stat.size} bytes)`);
      }
    }
  };
  await visit(root);
  return output;
}
function runProcess(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    (0, import_child_process.exec)(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const record = error;
        if (error && /maxbuffer/i.test(String(error.message || error.code || ""))) {
          resolve({
            exitCode: 0,
            stdout: String(stdout || ""),
            stderr: `${String(stderr || "")}\n[输出超过 16MB 上限，已被截断]`,
            timedOut: Boolean(record?.killed) && Date.now() - started >= timeoutMs - 100,
            durationMs: Date.now() - started,
            truncated: true
          });
          return;
        }
        resolve({
          exitCode: typeof record?.code === "number" ? record.code : error ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          timedOut: Boolean(record?.killed) && Date.now() - started >= timeoutMs - 100,
          durationMs: Date.now() - started
        });
      }
    );
  });
}
function runRg(args, cwd) {
  return new Promise((resolve, reject) => {
    (0, import_child_process.execFile)(
      "rg",
      args,
      { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 2 : 0;
        if (error && code !== 1) {
          reject(new Error(String(stderr || error.message)));
          return;
        }
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}
function assertCommandAllowed(command, scope) {
  if (scope === "system") return;
  const dangerous = [
    /\b(?:shutdown|reboot|restart-computer|format|diskpart|bcdedit)\b/i,
    /\b(?:winget|choco|scoop|apt|apt-get|dnf|yum|pacman|brew)\s+(?:install|uninstall|remove|upgrade|update)\b/i,
    /\breg(?:\.exe)?\s+(?:add|delete|import)\b/i,
    /\bnet\s+(?:user|localgroup)\b/i,
    /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*[fd])\b/i,
    /\bRemove-Item\b[^\r\n]*(?:-Recurse|-Force)/i,
    /\b(?:rm|rmdir)\b[^\r\n]*(?:-rf|-fr|\/s)\b/i
  ];
  if (dangerous.some((pattern) => pattern.test(command))) {
    throw new Error("\u8BE5\u547D\u4EE4\u8D85\u51FA TeleBox \u9879\u76EE\u6A21\u5F0F\u7684\u5B89\u5168\u8FB9\u754C\uFF1B\u8BF7\u6539\u7528 .sysagent \u660E\u786E\u6267\u884C\u7CFB\u7EDF\u7EA7\u4EFB\u52A1");
  }
}
function stripPluginPrefix(commandLine) {
  const trimmed = commandLine.trim();
  const matched = [...(0, import_pluginManager.getPrefixes)()].sort((left, right) => right.length - left.length).find((prefix) => trimmed.startsWith(prefix));
  return matched ? trimmed.slice(matched.length).trim() : trimmed;
}
function formatCommandResult(command, cwd, result) {
  return truncate(
    [
      `command: ${command}`,
      `cwd: ${cwd}`,
      `exit_code: ${result.exitCode}${result.timedOut ? " (timeout)" : ""}`,
      `duration_ms: ${result.durationMs}`,
      `stdout:
${result.stdout.trim() || "(empty)"}`,
      `stderr:
${result.stderr.trim() || "(empty)"}`
    ].join("\n")
  );
}
function validatePlan(args) {
  if (!Array.isArray(args.items) || !args.items.length) {
    throw new Error("\u8BA1\u5212 items \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const items = args.items.slice(0, 12).map((item) => {
    if (!item || typeof item !== "object") throw new Error("\u8BA1\u5212\u6B65\u9AA4\u683C\u5F0F\u65E0\u6548");
    const record = item;
    const step = asString(record.step).trim();
    const status = asString(record.status);
    if (!step || !["pending", "in_progress", "completed"].includes(status)) {
      throw new Error("\u8BA1\u5212\u6B65\u9AA4\u5FC5\u987B\u5305\u542B step \u548C\u6709\u6548 status");
    }
    return { step, status };
  });
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("\u8BA1\u5212\u4E2D\u6700\u591A\u53EA\u80FD\u6709\u4E00\u4E2A in_progress \u6B65\u9AA4");
  }
  return { explanation: asString(args.explanation).trim() || void 0, items };
}
async function executeTool(context, name, args) {
  if (name === "update_plan") {
    const plan = validatePlan(args);
    await context.onPlanChange(plan);
    return {
      ok: true,
      title: "\u8BA1\u5212\u5DF2\u66F4\u65B0",
      content: [
        plan.explanation || "\u8BA1\u5212\u5DF2\u66F4\u65B0",
        ...plan.items.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`)
      ].join("\n")
    };
  }
  if (name === "list_files") {
    const target = resolveAgentPath(context, args.path, ".");
    const stat = await import_fs.promises.stat(target);
    if (!stat.isDirectory()) throw new Error("\u76EE\u6807\u4E0D\u662F\u76EE\u5F55");
    const limit = asInt(args.max_entries, 120, 1, MAX_LIST_ENTRIES);
    const files = await collectFiles(context, target, Boolean(args.recursive), limit);
    return {
      ok: true,
      title: "\u76EE\u5F55\u5DF2\u8BFB\u53D6",
      content: files.length ? files.join("\n") : "(empty directory)"
    };
  }
  if (name === "read_file") {
    const target = resolveAgentPath(context, args.path);
    const stat = await import_fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("\u76EE\u6807\u4E0D\u662F\u6587\u4EF6");
    if (stat.size > MAX_TEXT_READ) throw new Error(`\u6587\u4EF6\u8FC7\u5927\uFF1A${stat.size} bytes`);
    const buffer = await import_fs.promises.readFile(target);
    if (buffer.includes(0)) {
      const ext = import_path.extname(target).toLowerCase();
      throw new Error(`\u8BE5\u6587\u4EF6\u770B\u8D77\u6765\u662F\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF08\u542B\u6709 NUL \u5B57\u8282\uFF09\uFF0C\u65E0\u6CD5\u4F5C\u4E3A\u6587\u672C\u8BFB\u53D6\u3002\u8BF7\u6539\u7528\u5176\u4ED6\u65B9\u5F0F\u5904\u7406\u6B64\u7C7B\u578B\u6587\u4EF6${ext ? `\uFF08${ext}\uFF09` : ""}\u3002`);
    }
    const text = buffer.toString("utf-8");
    const lines = text.split(/\r?\n/);
    const start = asInt(args.start_line, 1, 1, Math.max(1, lines.length));
    const end = asInt(args.end_line, Math.min(lines.length, start + 499), start, lines.length || start);
    const body = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5, " ")} | ${line}`).join("\n");
    return {
      ok: true,
      title: "\u6587\u4EF6\u5DF2\u8BFB\u53D6",
      content: truncate(
        `file: ${relativeDisplay(context, target)}
lines: ${start}-${end}/${lines.length}
${body}`
      )
    };
  }
  if (name === "search_files") {
    const query = asString(args.query).trim();
    if (!query) throw new Error("query 不能为空；请提供搜索关键词");
    const target = resolveAgentPath(context, args.path, ".");
    const maxResults = asInt(args.max_results, 120, 1, 300);
    const rgArgs = ["-n", "--no-heading", "--color", "never", "-m", String(maxResults)];
    if (Boolean(args.fixed_string)) rgArgs.push("-F");
    const glob = asString(args.glob).trim();
    if (glob) rgArgs.push("-g", glob);
    rgArgs.push(asString(args.query), target);
    const result = await runRg(rgArgs, context.projectRoot);
    return {
      ok: true,
      title: "\u641C\u7D22\u5B8C\u6210",
      content: truncate(result.stdout.trim() || "No matches found.")
    };
  }
  if (name === "write_file") {
    const target = resolveAgentPath(context, args.path);
    const content = asString(args.content);
    if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_SIZE) {
      throw new Error("\u5355\u6B21\u5199\u5165\u5185\u5BB9\u8D85\u8FC7 4 MB");
    }
    const existing = await import_fs.promises.stat(target).catch(() => null);
    if (existing?.isDirectory()) throw new Error("\u76EE\u6807\u662F\u76EE\u5F55");
    await import_fs.promises.mkdir(import_path.dirname(target), { recursive: true });
    const overwritten = existing && !existing.isDirectory() ? existing.size : 0;
    if (asString(args.mode) === "append") await import_fs.promises.appendFile(target, content, "utf-8");
    else await import_fs.promises.writeFile(target, content, "utf-8");
    const stat = await import_fs.promises.stat(target);
    return {
      ok: true,
      title: "文件已写入",
      content: `file: ${relativeDisplay(context, target)}\nsize: ${stat.size} bytes${overwritten ? `\noverwritten: 原文件 ${overwritten} bytes 已被覆盖` : ""}`
    };
  }
  if (name === "replace_text") {
    const target = resolveAgentPath(context, args.path);
    const stat = await import_fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("\u76EE\u6807\u4E0D\u662F\u6587\u4EF6");
    if (stat.size > MAX_TEXT_READ) throw new Error("\u6587\u4EF6\u8FC7\u5927\uFF0C\u65E0\u6CD5\u6587\u672C\u66FF\u6362");
    const oldText = asString(args.old_text);
    const newText = asString(args.new_text);
    if (!oldText) throw new Error("old_text \u4E0D\u80FD\u4E3A\u7A7A");
    const current = await import_fs.promises.readFile(target, "utf-8");
    const candidates = [oldText, oldText.endsWith("\n") ? oldText.slice(0, -1) : `${oldText}\n`];
    let matched = candidates.find((candidate) => current.includes(candidate));
    if (!matched) throw new Error("\u6587\u4EF6\u4E2D\u6CA1\u6709\u627E\u5230 old_text\uFF1B\u8BF7\u91CD\u65B0\u8BFB\u53D6\u6587\u4EF6\u540E\u7CBE\u786E\u5339\u914D\uFF08\u6CE8\u610F\u884C\u5C3E\u6362\u884C\u7B26\uFF09");
    const count = current.split(matched).length - 1;
    const next = Boolean(args.replace_all) ? current.split(matched).join(newText) : current.replace(matched, newText);
    await import_fs.promises.writeFile(target, next, "utf-8");
    return {
      ok: true,
      title: "\u6587\u4EF6\u5DF2\u4FEE\u6539",
      content: `file: ${relativeDisplay(context, target)}\nreplacements: ${Boolean(args.replace_all) ? count : 1}`
    };
  }
  if (name === "delete_file") {
    const target = resolveAgentPath(context, args.path);
    const stat = await import_fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("\u53EA\u80FD\u5220\u9664\u5355\u4E2A\u6587\u4EF6\uFF0C\u4E0D\u80FD\u5220\u9664\u76EE\u5F55");
    await import_fs.promises.unlink(target);
    return {
      ok: true,
      title: "\u6587\u4EF6\u5DF2\u5220\u9664",
      content: `file: ${relativeDisplay(context, target)}
size: ${stat.size} bytes`
    };
  }
  if (name === "run_command") {
    const command = asString(args.command).trim();
    if (!command) throw new Error("command \u4E0D\u80FD\u4E3A\u7A7A");
    assertCommandAllowed(command, context.scope);
    const cwd = resolveAgentPath(context, args.cwd, defaultRoot(context));
    const stat = await import_fs.promises.stat(cwd);
    if (!stat.isDirectory()) throw new Error("cwd \u4E0D\u662F\u76EE\u5F55");
    const timeoutMs = asInt(args.timeout_ms, context.commandTimeoutMs, 1e3, 864e5);
    const result = await runProcess(command, cwd, timeoutMs);
    return {
      ok: result.exitCode === 0,
      title: result.exitCode === 0 ? "\u547D\u4EE4\u6267\u884C\u5B8C\u6210" : "\u547D\u4EE4\u6267\u884C\u5931\u8D25",
      content: formatCommandResult(command, cwd, result)
    };
  }
  if (name === "list_plugins") {
    const rows = (0, import_pluginManager.listCommands)().filter((command) => !BLOCKED_PLUGIN_COMMANDS.has(command.toLowerCase())).map((command) => {
      const entry = (0, import_pluginManager.getPluginEntry)(command);
      return `${command}${entry?.plugin?.name ? ` \u2014 ${entry.plugin.name}` : ""}`;
    });
    return { ok: true, title: "\u63D2\u4EF6\u5217\u8868", content: rows.join("\n") || "(none)" };
  }
  if (name === "run_plugin") {
    const command = stripPluginPrefix(asString(args.command));
    const key = command.split(/\s+/, 1)[0]?.toLowerCase();
    if (!command || !key) throw new Error("\u63D2\u4EF6\u547D\u4EE4\u4E0D\u80FD\u4E3A\u7A7A");
    if (BLOCKED_PLUGIN_COMMANDS.has(key)) throw new Error(`\u7981\u6B62\u9012\u5F52\u8C03\u7528\u63D2\u4EF6\u547D\u4EE4\uFF1A${key}`);
    const output = await context.dispatchPlugin(command);
    return {
      ok: true,
      title: "\u63D2\u4EF6\u5DF2\u6267\u884C",
      content: truncate(output || `\u63D2\u4EF6\u547D\u4EE4\u5DF2\u6267\u884C\uFF1A${command}\uFF08\u6CA1\u6709\u6355\u83B7\u5230\u6587\u672C\u8F93\u51FA\uFF09`)
    };
  }
  if (name === "send_file") {
    const target = resolveAgentPath(context, args.path);
    const stat = await import_fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("\u53D1\u9001\u76EE\u6807\u4E0D\u662F\u6587\u4EF6");
    if (stat.size <= 0) throw new Error("\u6587\u4EF6\u4E3A\u7A7A");
    if (stat.size > MAX_SEND_SIZE) throw new Error("\u6587\u4EF6\u8D85\u8FC7 50 MB \u53D1\u9001\u4E0A\u9650");
    const client = context.msg.client || await (0, import_globalClient.getGlobalClient)();
    if (!client?.sendFile) throw new Error("Telegram client \u4E0D\u652F\u6301\u53D1\u9001\u6587\u4EF6");
    await client.sendFile(context.msg.peerId, {
      file: target,
      caption: asString(args.caption).trim() || `\u6587\u4EF6\uFF1A${import_path.basename(target)}`,
      replyTo: context.msg.replyTo?.replyToTopId || context.msg.replyTo?.replyToMsgId || void 0
    });
    return {
      ok: true,
      title: "\u6587\u4EF6\u5DF2\u53D1\u9001",
      content: `file: ${relativeDisplay(context, target)}
size: ${stat.size} bytes`
    };
  }
  throw new Error(`\u672A\u77E5\u5DE5\u5177\uFF1A${name}`);
}
function createToolRuntime(context) {
  return {
    definitions: context.answerOnly ? [] : TOOL_DEFINITIONS,
    maxCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
    execute: async (name, args) => {
      await context.onToolStart(name, args);
      let result;
      try {
        result = await executeTool(context, name, args);
      } catch (error) {
        result = {
          ok: false,
          title: "\u5DE5\u5177\u6267\u884C\u5931\u8D25",
          content: error instanceof Error ? error.message : String(error)
        };
      }
      await context.onToolFinish(name, args, result);
      return result;
    }
  };
}

// plugins/agent/store.ts
import import_fs2 = require("fs");
import import_path2 = require("path");
import import_node = require("lowdb/node");
import import_pathHelpers = require("@utils/pathHelpers");
var UAI_DIR = (0, import_pathHelpers.createDirectoryInAssets)("uai");
var ZN_CONFIG_PATH = import_path2.join(UAI_DIR, "config.json");
var WORKSPACE_ROOT = import_path2.join(UAI_DIR, "workspaces");
var AGENT_SCHEMA_VERSION = 3;
var LEGACY_BUILTIN_SKILL_SUFFIX = "\u7F16\u7A0B\u667A\u80FD\u4F53\u9ED8\u8BA4\u89C4\u5219";
var LEGACY_NAME_PATTERNS = [/^Curs[o]r$/i, /^Cod[e]x$/i];
var DEFAULT_TIMEOUT_MS = 12e4;
var DEFAULT_COMMAND_TIMEOUT_MS = 12e4;
var DEFAULT_MAX_STEPS = 12;
var DEFAULT_CONTEXT_LIMIT = 20;
var MAX_CONTEXT_LIMIT = 40;
var MAX_AGENT_STEPS = 100;
var DEFAULT_WORKSPACE_ID = "1";
var DEFAULT_CONFIG = {
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
var writeQueue = Promise.resolve();
function migrateLegacyAgentData(config) {
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
  // 兼容：旧版 active_provider 是扁平配置对象（非名称），迁移进 ai_providers
  if (config.active_provider && typeof config.active_provider === "object") {
    const legacy = config.active_provider;
    config.ai_providers = config.ai_providers || {};
    if (!config.ai_providers.__default) {
      config.ai_providers.__default = { ...legacy, name: "__default" };
      config.ai_providers.__default.api_interface = config.ai_providers.__default.api_interface || detectProviderInterface(config.ai_providers.__default);
      changed = true;
    }
    config.active_provider = "__default";
  }
  if (config.active_provider && !config.ai_providers?.[config.active_provider]) {
    config.active_provider = null;
  }
  return changed;
}
function normalizeDisplayName(value) {
  const name = String(value || "").trim().slice(0, 32);
  if (!name || LEGACY_NAME_PATTERNS.some((pattern) => pattern.test(name))) return "";
  return name;
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function sanitizePart(text) {
  return (text.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "workspace").slice(0, 80);
}
function createConversationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function compactContent(content) {
  const text = String(content || "").trim();
  return text.length <= 6e3 ? text : `${text.slice(0, 5970)}
\u2026\uFF08\u8BB0\u5FC6\u5DF2\u622A\u65AD\uFF09`;
}
function normalizeConversation(value, limit) {
  const raw = value && typeof value === "object" ? value : {};
  const messages = Array.isArray(raw.messages) ? raw.messages.filter(
    (item) => Boolean(item) && typeof item === "object" && (item.role === "user" || item.role === "assistant") && typeof item.content === "string"
  ).map((item) => ({
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
function valueToKey(value) {
  if (value === null || value === void 0) return "";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(valueToKey).filter(Boolean).join("_");
  if (typeof value === "object") {
    const record = value;
    for (const key of ["userId", "chatId", "channelId", "peerId", "id", "value"]) {
      const part = valueToKey(record[key]);
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
async function readConfig() {
  const db = await (0, import_node.JSONFilePreset)(ZN_CONFIG_PATH, DEFAULT_CONFIG);
  const data = db.data;
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
async function updateConfig(mutator) {
  let result;
  const operation = writeQueue.then(async () => {
    const db = await (0, import_node.JSONFilePreset)(ZN_CONFIG_PATH, DEFAULT_CONFIG);
    migrateLegacyAgentData(db.data);
    result = await mutator(db.data);
    await db.write();
  });
  writeQueue = operation.catch(() => void 0);
  await operation;
  return result;
}
function getModelTimeout(config) {
  return clamp(positiveInt(config.timeout, DEFAULT_TIMEOUT_MS), 1e4, 24 * 60 * 6e4);
}
function getCommandTimeout(config) {
  return clamp(
    positiveInt(config.system_timeout, DEFAULT_COMMAND_TIMEOUT_MS),
    1e4,
    24 * 60 * 6e4
  );
}
function getMaxSteps(config) {
  return clamp(positiveInt(config.max_agent_steps, DEFAULT_MAX_STEPS), 1, MAX_AGENT_STEPS);
}
function getContextLimit(config) {
  return clamp(
    positiveInt(config.conversation_context_limit, DEFAULT_CONTEXT_LIMIT),
    1,
    MAX_CONTEXT_LIMIT
  );
}
function getProvider(config) {
  const name = config.active_provider;
  if (!name) return null;
  const provider = config.ai_providers?.[name];
  if (!provider?.base_url || !provider?.api_key || !provider?.model) return null;
  return { name, ...provider };
}
function getProviders(config) {
  const map = config.ai_providers || {};
  return Object.keys(map).map((name) => ({ name, ...map[name] }));
}
function detectProviderInterface(input) {
  const hint = String(input?.base_url || input?.model || "").toLowerCase();
  if (/anthropic\.com|claude/.test(hint)) return "anthropic";
  if (/openai\.com|gpt-|chatgpt|o1|o3/.test(hint)) return "openai";
  if (/googleapis\.com|gemini/.test(hint)) return "gemini";
  return String(input?.api_interface || input?.type || "openai").toLowerCase();
}
async function setProvider(name, fields) {
  name = String(name || "").trim();
  if (!/^[\w.-]{1,32}$/.test(name)) throw new Error("供应商名称仅允许字母、数字、._-，长度 1-32");
  await updateConfig((config) => {
    config.ai_providers = config.ai_providers || {};
    const prev = config.ai_providers[name] || {};
    const next = { ...prev, ...fields, name };
    next.api_interface = next.api_interface || detectProviderInterface(next);
    config.ai_providers[name] = next;
    if (!config.active_provider) config.active_provider = name;
  });
}
async function removeProvider(name) {
  await updateConfig((config) => {
    config.ai_providers = config.ai_providers || {};
    delete config.ai_providers[name];
    if (config.active_provider === name) config.active_provider = Object.keys(config.ai_providers)[0] || null;
  });
}
function getDisplayName(config) {
  return normalizeDisplayName(config.zn_name);
}
function getConversationBaseKey(msg, scope) {
  const source = msg.peerId || msg.chatId || msg.savedPeerId || msg.senderId || "global";
  const peer = valueToKey(source).replace(/\s+/g, "_").slice(0, 180) || "global";
  return `${scope}:${peer}`;
}
function normalizeWorkspaceId(value) {
  const text = String(value || "").trim();
  if (!/^[1-9]\d{0,2}$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return parsed >= 1 && parsed <= 999 ? String(parsed) : null;
}
function getWorkspaceInfo(config, baseKey) {
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
async function getSession(msg, scope) {
  const config = await readConfig();
  const baseKey = getConversationBaseKey(msg, scope);
  const workspace = getWorkspaceInfo(config, baseKey);
  const conversation = normalizeConversation(
    config.zn_conversations?.[workspace.conversationKey],
    getContextLimit(config)
  );
  return { config, workspace, conversation };
}
function conversationToMessages(conversation) {
  return conversation.messages.map((item) => ({
    role: item.role,
    content: item.content
  }));
}
async function appendConversation(msg, scope, entries) {
  await updateConfig((config) => {
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
      ...entries.map((entry) => ({
        role: entry.role,
        content: compactContent(entry.content),
        at: now
      })).filter((entry) => entry.content)
    ].slice(-limit);
    config.zn_conversations[workspace.conversationKey] = current;
    const ordered = Object.entries(config.zn_conversations).sort(
      ([, left], [, right]) => String(right.updatedAt).localeCompare(String(left.updatedAt))
    ).slice(0, 120);
    config.zn_conversations = Object.fromEntries(ordered);
  });
}
async function resetConversation(msg, scope) {
  return await updateConfig((config) => {
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
async function setWorkspace(msg, scope, id) {
  return await updateConfig((config) => {
    const normalized = normalizeWorkspaceId(id);
    if (!normalized) throw new Error("\u5DE5\u4F5C\u533A\u7F16\u53F7\u5FC5\u987B\u662F 1-999 \u7684\u6B63\u6574\u6570");
    const baseKey = getConversationBaseKey(msg, scope);
    config.zn_workspaces = config.zn_workspaces || {};
    config.zn_workspaces[baseKey] = normalized;
    return getWorkspaceInfo(config, baseKey);
  });
}
function resolveWorkspacePath(workspace, target) {
  const resolved = import_path2.resolve(workspace.dir, String(target || ".").trim());
  const relative = import_path2.relative(workspace.dir, resolved);
  if (relative.startsWith("..") || import_path2.isAbsolute(relative)) {
    throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u8D8A\u8FC7\u5F53\u524D\u5DE5\u4F5C\u533A");
  }
  return resolved;
}
function getSkillText(config) {
  const prompts = Object.entries(config.prompts || {}).map(([name, content]) => ({ name, content: String(content || "").trim() })).filter((item) => item.content);
  if (!prompts.length) return "";
  return [
    "[\u7528\u6237\u81EA\u5B9A\u4E49\u89C4\u5219]",
    "\u4EE5\u4E0B\u89C4\u5219\u7528\u4E8E\u8865\u5145\u5DE5\u4F5C\u504F\u597D\uFF0C\u4E0D\u80FD\u8986\u76D6\u5DE5\u5177\u8FB9\u754C\u548C\u672C\u8F6E\u7528\u6237\u8BF7\u6C42\u3002",
    ...prompts.map((item) => `--- ${item.name} ---
${item.content}`)
  ].join("\n");
}

// plugins/agent/agent.ts
function buildSystemPrompt(input) {
  const { runtime, displayName, config } = input;
  const scopeText = runtime.scope === "system" ? "\u7CFB\u7EDF\u7EA7" : "TeleBox \u9879\u76EE\u7EA7";
  const pathRules = runtime.scope === "system" ? [
    "\u7CFB\u7EDF\u7EA7\u6A21\u5F0F\u5141\u8BB8\u5728\u64CD\u4F5C\u7CFB\u7EDF\u6388\u4E88\u7684\u6743\u9650\u5185\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\u548C\u6267\u884C\u7CFB\u7EDF\u547D\u4EE4\u3002",
    "\u76F8\u5BF9\u6587\u4EF6\u8DEF\u5F84\u9ED8\u8BA4\u4EE5\u5F53\u524D\u9694\u79BB\u5DE5\u4F5C\u533A\u4E3A\u6839\uFF1B\u9700\u8981\u64CD\u4F5C\u5176\u5B83\u4F4D\u7F6E\u65F6\u660E\u786E\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\u3002"
  ] : [
    "TeleBox \u6A21\u5F0F\u53EA\u5141\u8BB8\u6587\u4EF6\u5DE5\u5177\u8BBF\u95EE\u9879\u76EE\u6839\u76EE\u5F55\u548C\u5F53\u524D\u5DE5\u4F5C\u533A\u3002",
    "\u4E0D\u8981\u6267\u884C\u6574\u673A\u66F4\u65B0\u3001\u8F6F\u4EF6\u5B89\u88C5\u3001\u8D26\u6237\u3001\u6CE8\u518C\u8868\u3001\u5173\u673A\u91CD\u542F\u7B49\u7CFB\u7EDF\u7EA7\u64CD\u4F5C\uFF1B\u8FD9\u7C7B\u4EFB\u52A1\u8981\u6C42\u7528\u6237\u6539\u7528 .sysagent\u3002"
  ];
  return [
    displayName ? `[身份]\n你是运行在 TeleBox 中的${scopeText}编程智能体，自定义名称为「${displayName}」。` : `[身份]\n你是运行在 TeleBox 中的${scopeText}编程智能体；当前未设置自定义名称。`,
    [
      "[核心职责]",
      "- 你是用户的编程协作者：通过工具观察环境、读写文件、运行命令、调用 TeleBox 插件并发送文件，帮助用户完成真实开发任务。",
      "- 你服务于真实目标，而不是演示。每一次回复都应把任务向前推进一步。"
    ].join("\n"),
    [
      "[工作原则]",
      "- 执行优先：对操作型请求，先实际执行，再依据工具返回的真实观测继续；绝不要把计划、建议或「正在执行」当作最终结果。",
      "- 先理解后动手：编程任务先读取相关文件与项目约定（如 README、CONTRIBUTING、包配置、测试约定），做最小有效改动，然后运行最接近的类型检查、测试或构建来验证。",
      "- 自主推进：工具失败就读取错误并修正；只要仍能自主推进，就不要把工作退回给用户。",
      "- 收尾条件：仅当目标已完成、确认无需操作、明确失败且无法继续、或确需用户做关键选择时，才给出最终回复。",
      "- 真实汇报：最终回复先说结论，再简要列出改动、验证与剩余风险；绝不编造观测，绝不谎报工具成功。"
    ].join("\n"),
    [
      "[规划]",
      "- 复杂或多步骤任务使用 update_plan，并在执行中更新各步骤状态；计划本身不是完成。",
      "- 每个 in_progress 步骤完成后立即标记 completed，再开启下一步。",
      runtime.planFirst ? "本论是计划执行入口：若任务不止一个动作，首次执行工具前先调用 update_plan 列出完整步骤。" : "简单任务可直接执行；不要为了形式创建无意义的计划。"
    ].join("\n"),
    [
      "[环境]",
      `项目根目录：${runtime.projectRoot}`,
      `当前工作区：${runtime.workspace.dir}`,
      "工具路径可使用 `$project/...` 与 `$workspace/...` 指代根目录与工作区。",
      ...pathRules
    ].join("\n"),
    [
      "[工具使用规则]",
      "- 读代码优先 list_files、search_files、read_file；写之前先确认路径与现有结构。",
      "- 小范围修改优先 replace_text（注意行尾换行符）；完整创建或重写文件用 write_file。",
      "- run_command 用于检查、测试、构建与必要的终端操作；不能伪造命令结果，失败要读 stderr。",
      "- 需要其它 TeleBox 能力时，先 list_plugins 了解可用命令，再 run_plugin 调用，不要把插件能力当成已知。",
      "- send_file 成功前不能声称文件已发送。",
      "- 一轮可返回多个互不冲突的工具调用以并行推进；但不要重复完全相投且无新信息的调用（相同调用连续失败 3 次会触发熔断）。"
    ].join("\n"),
    [
      "[输出格式]",
      "- 用用户语言回复（通常为中文）；技术术语、命令、文件路径、代码保留原文。",
      "- 不要使用 XML/JSON 信封包裹最终回复，直接给出自然语言结论。",
      "- 最终回复控制在 1–3 段：结论 → 关键改动与验证 → 剩余风险或建议的下一步。"
    ].join("\n"),
    [
      "[自我纠错]",
      "- 工具报错时，读取错误原文、定位根因、针对性修正后重试；不要盲目重复相同调用。",
      "- 若同一工具连续失败，换一种方法或基于现有观测给出结论，必要时清楚说明无法完成的原因。",
      "- 上下文过长或工具循环无进展时，主动收敛：先汇报已知事实，再询问用户是否需要调整方向。"
    ].join("\n"),
    runtime.answerOnly ? "[问答模式]\n本轮禁止工具调用，只回答问题；如果必须实际操才能完成任务，请明确建议用户改用普通 .agent 或 .sysagent。" : "",
    [
      "[兼容兜底]",
      "优先使用接口提供的原生 function/tool calling。只有接口不支持原生工具时，才返回单个严格 JSON：",
      '{"tool":"read_file","arguments":{"path":"plugins/example.ts"}}',
      "不要用自然语言声称调用了工具。"
    ].join("\n"),
    getSkillText(config)
  ].filter(Boolean).join("\n\n");
}
function extractJson(text) {
  let value = String(text || "").trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) value = fenced[1].trim();
  if (value.startsWith("{") && value.endsWith("}")) {
    const parsed = safeParseJson(value);
    if (parsed) return parsed;
  }
  const start = value.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const parsed = safeParseJson(value.slice(start, index + 1));
        if (parsed) return parsed;
        return null;
      }
    }
  }
  return null;
}
function safeParseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function legacyToolCall(text) {
  const parsed = extractJson(text);
  if (!parsed) return null;
  if (typeof parsed.tool === "string") {
    return {
      call: {
        id: `legacy_${Date.now()}`,
        name: parsed.tool,
        arguments: parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments) ? parsed.arguments : {}
      }
    };
  }
  if (parsed.action === "answer" && typeof parsed.content === "string") {
    return { answer: parsed.content };
  }
  const actionMap = {
    run_system: "run_command",
    execute_command: "run_command",
    exec: "run_command",
    shell: "run_command",
    run_command: "run_command",
    run_plugin: "run_plugin",
    send_file: "send_file",
    delete_workspace_file: "delete_file",
    delete_file: "delete_file"
  };
  const tool = typeof parsed.action === "string" ? actionMap[parsed.action] : "";
  if (!tool) return null;
  const args = {};
  if (typeof parsed.command === "string") args.command = parsed.command;
  if (typeof parsed.path === "string") args.path = parsed.path;
  if (typeof parsed.content === "string") args.content = parsed.content;
  if (typeof parsed.query === "string") args.query = parsed.query;
  if (typeof parsed.caption === "string") args.caption = parsed.caption;
  if (typeof parsed.old_text === "string") args.old_text = parsed.old_text;
  if (typeof parsed.new_text === "string") args.new_text = parsed.new_text;
  return { call: { id: `legacy_${Date.now()}`, name: tool, arguments: args } };
}
function toolResultMessage(call, ok, content) {
  return {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: JSON.stringify({ ok, content })
  };
}
function fingerprint(call) {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}
async function runAgent(input) {
  const { runtime } = input;
  const tools = createToolRuntime(runtime);
  const messages = [
    { role: "system", content: buildSystemPrompt(input) },
    ...input.history,
    input.userMessage
  ];
  let usage;
  const callCounts = /* @__PURE__ */ new Map();
  let lastObservation = "";
  for (let step = 1; step <= runtime.maxSteps; step += 1) {
    await input.onStep(step);
    const turn = await callModel(
      runtime.provider,
      messages,
      tools.definitions,
      runtime.timeoutMs
    );
    usage = addUsage(usage, turn.usage);
    await input.onUsage(usage);
    let calls = runtime.answerOnly ? [] : turn.toolCalls;
    if (!calls.length && !runtime.answerOnly) {
      const fallback = legacyToolCall(turn.text);
      if (fallback?.answer !== void 0) {
        return { answer: fallback.answer, usage };
      }
      if (fallback?.call) calls = [fallback.call];
    }
    if (!calls.length) {
      if (turn.text.trim()) return { answer: turn.text.trim(), usage };
      messages.push({
        role: "user",
        content: "\u4F60\u8FD9\u4E00\u8F6E\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u4E5F\u6CA1\u6709\u8C03\u7528\u5DE5\u5177\u3002\u8BF7\u4E3B\u52A8\u9009\u62E9\u4E00\u4E2A\u5177\u4F53\u4E0B\u4E00\u6B65\uFF08\u8BFB\u53D6\u3001\u641C\u7D22\u3001\u8FD0\u884C\u547D\u4EE4\u6216\u4FEE\u6539\uFF09\u5E76\u6267\u884C\uFF1B\u4EC5\u5F53\u4EFB\u52A1\u5DF2\u5B8C\u6210\u65F6\u624D\u76F4\u63A5\u7ED9\u51FA\u7B80\u6D01\u6700\u7EC8\u7B54\u590D\u3002\u4E0D\u8981\u53EA\u8BF4\u660E\u4F60\u6253\u7B97\u505A\u4EC0\u4E48\u3002"
      });
      continue;
    }
    const selectedCalls = calls.slice(0, tools.maxCallsPerTurn);
    if (calls.length > selectedCalls.length) {
      messages.push(toolResultMessage(
        selectedCalls[selectedCalls.length - 1],
        true,
        `\u672C\u8F6E\u5DF2\u6267\u884C ${selectedCalls.length}/${calls.length} \u6B21\u5DE5\u5177\u8C03\u7528\uFF08\u4E0A\u9650 ${tools.maxCallsPerTurn}\uFF09\uFF0C\u5269\u4F59 ${calls.length - selectedCalls.length} \u4E2A\u5C06\u5728\u4E0B\u4E00\u8F6E\u7EE7\u7EED\u3002`
      ));
    }
    messages.push({ role: "assistant", content: turn.text, toolCalls: selectedCalls });
    for (const call of selectedCalls) {
      const key = fingerprint(call);
      const count = (callCounts.get(key) || 0) + 1;
      callCounts.set(key, count);
      if (count > 3) {
        const content = "\u76F8\u540C\u7684\u5DE5\u5177\u8C03\u7528\u5DF2\u8FDE\u7EED 3 \u6B21\u4E14\u672A\u4EA7\u751F\u65B0\u8FDB\u5C55\uFF0C\u5DF2\u81EA\u52A8\u8DF3\u8FC7\u3002\u8BF7\u6362\u4E00\u79CD\u65B9\u6CD5\uFF1A\u5148\u8BFB\u53D6\u4E0A\u4E00\u6B21\u7684\u771F\u5B9E\u8FD4\u56DE\u5B9A\u4F4D\u6839\u56E0\uFF0C\u6216\u57FA\u4E8E\u73B0\u6709\u89C2\u5BDF\u7ED9\u51FA\u7ED3\u8BBA\uFF1B\u82E5\u786E\u5B9E\u65E0\u6CD5\u7EE7\u7EED\u8BF7\u660E\u8BF4\u539F\u56E0\u3002";
        messages.push(toolResultMessage(call, false, content));
        lastObservation = content;
        continue;
      }
      const result = await tools.execute(call.name, call.arguments);
      lastObservation = result.content;
      messages.push(toolResultMessage(call, result.ok, result.content));
    }
  }
  await input.onStep(runtime.maxSteps);
  messages.push({
    role: "user",
    content: [
      "\u5DF2\u8FBE\u5230\u672C\u8F6E\u5DE5\u5177\u8C03\u7528\u4E0A\u9650\uFF0C\u4E0D\u80FD\u518D\u8C03\u7528\u5DE5\u5177\u3002\u8BF7\u4EC5\u73B0\u6709\u771F\u5B9E\u89C2\u5BDF\u4E3A\u4F9D\u636E\uFF0C\u7ED9\u7528\u6237\u4E00\u4E2A\u6700\u7EC8\u72B6\u6001\uFF1A\u5DF2\u5B8C\u6210\u4EC0\u4E48\u3001\u9A8C\u8BC1\u7ED3\u679C\u3001\u5C1A\u672A\u5B8C\u6210\u4EC0\u4E48\u53CA\u539F\u56E0\u3002\u82E5\u9700\u7EE7\u7EED\u53EF\u8BA9\u7528\u6237\u7528 .plan \u91CD\u542F\u5E76\u8865\u5145\u6B65\u9AA4\u3002",
      "\u8BF7\u53EA\u6839\u636E\u5DF2\u7ECF\u53D1\u751F\u7684\u771F\u5B9E\u5DE5\u5177\u89C2\u5BDF\uFF0C\u7ED9\u7528\u6237\u4E00\u4E2A\u6700\u7EC8\u72B6\u6001\uFF1A\u5B8C\u6210\u4E86\u4EC0\u4E48\u3001\u9A8C\u8BC1\u7ED3\u679C\u3001\u5C1A\u672A\u5B8C\u6210\u4EC0\u4E48\u4EE5\u53CA\u539F\u56E0\u3002",
      lastObservation ? `\u6700\u8FD1\u89C2\u5BDF\uFF1A
${lastObservation}` : "\u672C\u8F6E\u6CA1\u6709\u53EF\u7528\u89C2\u5BDF\u3002"
    ].join("\n\n")
  });
  const finalTurn = await callModel(runtime.provider, messages, [], runtime.timeoutMs);
  usage = addUsage(usage, finalTurn.usage);
  await input.onUsage(usage);
  return {
    answer: finalTurn.text.trim() || `\u5DF2\u8FBE\u5230\u6700\u5927\u5DE5\u4F5C\u8F6E\u6570\uFF08${runtime.maxSteps}\uFF09\uFF0C\u65E0\u6CD5\u5728\u672C\u8F6E\u786E\u8BA4\u4EFB\u52A1\u5B8C\u6574\u5B8C\u6210\u3002\u6700\u8FD1\u89C2\u5BDF\uFF1A${lastObservation || "\u65E0"}`,
    usage
  };
}

// plugins/agent/telegram.ts
import import_fs3 = require("fs");
import import_path3 = require("path");
import import_teleproto = require("teleproto");
import import_globalClient2 = require("@utils/globalClient");
import import_pluginManager2 = require("@utils/pluginManager");
var SAFE_MESSAGE_LIMIT = 3900;
var MAX_REPLY_DOWNLOAD = 20 * 1024 * 1024;
var MAX_INLINE_TEXT = 6e4;
var IMAGE_MIMES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
var TEXT_EXTENSIONS = /\.(txt|md|csv|json|jsonl|yaml|yml|toml|ini|cfg|conf|log|py|ts|js|jsx|tsx|sh|bat|ps1|html|htm|xml|sql|go|rs|java|c|cpp|h|cs|php|rb|swift|kt|env|properties)$/i;
var TEXT_MIMES = /^(text\/|application\/(json|javascript|xml|x-yaml|x-sh|x-python|toml|csv|sql|typescript))/i;
function tgEscape(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function tgCode(text) {
  return `<code>${tgEscape(text)}</code>`;
}
function tgBold(text) {
  return `<b>${tgEscape(text)}</b>`;
}
function tgBlockquote(text, expandable = false) {
  return `<blockquote${expandable ? " expandable" : ""}>${tgEscape(text || " ")}</blockquote>`;
}
function tgHtmlBlockquote(html, expandable = false) {
  return `<blockquote${expandable ? " expandable" : ""}>${html || " "}</blockquote>`;
}
function renderSharedAiIcon(icon) {
  return tgEscape(icon?.value || "\u{1F916}");
}
function stripTelegramHtml(text) {
  return String(text || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|blockquote|pre)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
}
function truncate2(text, max = SAFE_MESSAGE_LIMIT) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max - 18)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF09`;
}
function payloadText(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload;
  for (const key of ["text", "message", "caption"]) {
    if (typeof record[key] === "string") return record[key];
  }
  if (record.file || record.files || record.media) return "\uFF08\u53D1\u9001\u4E86\u6587\u4EF6\u6216\u5A92\u4F53\uFF09";
  return "";
}
function redactText(text, provider) {
  let result = String(text || "");
  const secrets = [provider?.api_key, ...Object.entries(process.env).filter(([key, value]) => value && /(key|token|secret|password|cookie|authorization)/i.test(key)).map(([, value]) => value)].filter((value) => Boolean(value && value.length >= 8)).sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    const visible = secret.length > 12 ? `${secret.slice(0, 4)}\u2026${secret.slice(-4)}` : "***";
    result = result.split(secret).join(visible);
  }
  return result.replace(/\b(sk-[A-Za-z0-9._-]{10,})\b/g, (value) => `${value.slice(0, 4)}\u2026${value.slice(-4)}`).replace(
    /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (_match, prefix, value) => `${prefix}${String(value).slice(0, 4)}\u2026${String(value).slice(-4)}`
  );
}
async function safeEdit(msg, text, options = {}) {
  const safePlain = stripTelegramHtml(String(options.plainFallback != null ? options.plainFallback : text));
  try {
    await msg.edit({
      text: options.html ? text : truncate2(text),
      parseMode: options.html ? "html" : void 0,
      linkPreview: false
    });
    return msg;
  } catch (error) {
    if (/MESSAGE_NOT_MODIFIED|message (?:is )?not modified/i.test(String(error))) return msg;
    if (options.html) {
      try {
        await msg.edit({ text: truncate2(safePlain), linkPreview: false });
        return msg;
      } catch {
      }
    }
    try {
      const sent = await msg.reply({
        message: options.html ? text : truncate2(text),
        parseMode: options.html ? "html" : void 0,
        linkPreview: false
      });
      return sent || msg;
    } catch {
      if (options.html) {
        try {
          const sent = await msg.reply({ message: truncate2(safePlain), linkPreview: false });
          return sent || msg;
        } catch {
        }
      }
      return msg;
    }
  }
}
async function safeReply(msg, text, options = {}) {
  const safePlain = stripTelegramHtml(String(options.plainFallback != null ? options.plainFallback : text));
  try {
    const sent = await msg.reply({
      message: options.html ? text : truncate2(text),
      parseMode: options.html ? "html" : void 0,
      linkPreview: false
    });
    return sent || null;
  } catch {
    if (options.html) {
      try {
        const sent = await msg.reply({ message: truncate2(plainFallback), linkPreview: false });
        return sent || null;
      } catch {
      }
    }
    return null;
  }
}
function splitLongText(text, max = SAFE_MESSAGE_LIMIT) {
  const value = String(text || "");
  if (value.length <= max) return [value];
  const chunks = [];
  let remaining = value;
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n", max);
    if (splitAt < max * 0.6) splitAt = max;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
function splitMarkdownText(text, max = 3e3) {
  const lines = String(text || "").split(/\r?\n/);
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let openFence = "";
  const flush = () => {
    if (!current.length) return;
    if (openFence && !/^```\s*$/.test(current[current.length - 1] || "")) {
      current.push("```");
    }
    chunks.push(current.join("\n"));
    current = openFence ? [openFence] : [];
    currentLength = current.join("\n").length;
  };
  for (const line of lines) {
    if (line.length > max) {
      flush();
      for (let index = 0; index < line.length; index += max) {
        chunks.push(line.slice(index, index + max));
      }
      continue;
    }
    const extra = line.length + (current.length ? 1 : 0);
    if (currentLength + extra > max) flush();
    current.push(line);
    currentLength += line.length + (current.length > 1 ? 1 : 0);
    const fence = line.match(/^```[^`]*$/);
    if (fence) openFence = openFence ? "" : line;
  }
  flush();
  return chunks.length ? chunks : [""];
}
function markdownToTelegramHtml(markdown) {
  let source = String(markdown || "");
  const blocks = [];
  const inlineCodes = [];
  source = source.replace(/```([a-z0-9_+.-]+)?\n([\s\S]*?)```/gi, (_match, language, code) => {
    const className = language ? ` class="language-${tgEscape(String(language).toLowerCase())}"` : "";
    const index = blocks.push(`<pre><code${className}>${tgEscape(String(code).replace(/\n$/, ""))}</code></pre>`) - 1;
    return `\0BLOCK${index}\0`;
  });
  source = source.replace(/`([^`\n]+)`/g, (_match, code) => {
    const index = inlineCodes.push(`<code>${tgEscape(String(code))}</code>`) - 1;
    return `\0INLINE${index}\0`;
  });
  let html = tgEscape(source);
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>").replace(/~~([^~\n]+)~~/g, "<s>$1</s>").replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>').replace(/\u0000INLINE(\d+)\u0000/g, (_match, index) => inlineCodes[Number(index)] || "").replace(/\u0000BLOCK(\d+)\u0000/g, (_match, index) => blocks[Number(index)] || "");
  return html.trim();
}
function usageTotal(usage) {
  if (typeof usage?.total === "number") return String(usage.total);
  const total = (usage?.prompt || 0) + (usage?.completion || 0);
  return total ? String(total) : "\u672A\u77E5";
}
function elapsed(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1e3));
  if (seconds < 60) return `${seconds}\u79D2`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}\u5206${seconds % 60}\u79D2`;
}
function toolLabel(name) {
  return {
    update_plan: "\u66F4\u65B0\u8BA1\u5212",
    list_files: "\u5217\u51FA\u6587\u4EF6",
    read_file: "\u8BFB\u53D6\u6587\u4EF6",
    search_files: "\u641C\u7D22\u4EE3\u7801",
    write_file: "\u5199\u5165\u6587\u4EF6",
    replace_text: "\u4FEE\u6539\u6587\u4EF6",
    delete_file: "\u5220\u9664\u6587\u4EF6",
    run_command: "\u8FD0\u884C\u547D\u4EE4",
    list_plugins: "\u5217\u51FA\u63D2\u4EF6",
    run_plugin: "\u8C03\u7528\u63D2\u4EF6",
    send_file: "\u53D1\u9001\u6587\u4EF6"
  }[name] || name;
}
function summarizeArgs(args) {
  for (const key of ["command", "path", "file", "target", "query", "url", "caption"]) {
    if (args[key] !== void 0) return truncate2(String(args[key]).replace(/\s+/g, " "), 180);
  }
  if (Array.isArray(args.items)) return `${args.items.length} \u4E2A\u8BA1\u5212\u6B65\u9AA4`;
  const keys = Object.keys(args);
  if (keys.length === 1) return truncate2(String(args[keys[0]]).replace(/\s+/g, " "), 180);
  return keys.join(", ") || "\u65E0\u53C2\u6570";
}
var AgentStatus = class {
  constructor(input) {
    this.startedAt = Date.now();
    this.step = 1;
    this.state = "\u6B63\u5728\u63A5\u6536\u4EFB\u52A1\uFF0C\u51C6\u5907\u52A8\u624B\u2026";
    this.latest = "";
    this.observations = [];
    this.toolCount = 0;
    this.aborted = false;
    this.lastEditAt = 0;
    this.anchor = input.msg;
    this.displayName = input.displayName;
    this.provider = input.provider;
    this.workspace = input.workspace;
    this.maxSteps = input.maxSteps;
    this.icon = input.icon;
    this.request = String(input.request || "").trim();
  }
  setStep(step) {
    this.step = step;
  }
  setUsage(usage) {
    this.usage = usage;
  }
  async setPlan(plan) {
    this.plan = plan;
    this.state = "\u8BA1\u5212\u5DF2\u66F4\u65B0\uff0c\u9a6c\u4e0d\u505c\u6b65\u5730\u63a8\u8fdb\u2026";
    await this.render(true);
  }
  async thinking() {
    this.state = "\u6B63\u5728\u5206\u6790\u5F53\u524D\u60C5\u51B5\uFF0C\u51B3\u5B9A\u4E0B\u4E00\u6B65\u2026";
    await this.render();
  }
  async toolStart(name, args) {
    this.state = `${toolLabel(name)}\uFF1A${summarizeArgs(args)}`;
    await this.render(true);
  }
  async toolFinish(name, args, result) {
    const firstLine = result.content.split(/\r?\n/).find((line) => line.trim()) || "\u65E0\u8F93\u51FA";
    this.latest = `${result.ok ? "\u2713" : "\u2717"} ${toolLabel(name)}\uFF1A${summarizeArgs(args)}
${truncate2(firstLine, 220)}`;
    this.state = result.ok ? "\u5DF2\u62FF\u5230\u7ED3\u679C\uFF0C\u6B63\u5728\u63A8\u8FDB\u2026" : "\u8FD9\u6B65\u51FA\u4E86\u70B9\u72B6\u51B5\uFF0C\u6B63\u5728\u67E5\u539F\u56E0\u2026";
    await this.render(true);
  }
  markAborted() {
    this.aborted = true;
  }
  build() {
    const displayName = tgEscape(redactText(this.displayName, this.provider));
    const model = tgEscape(redactText(this.provider.model, this.provider));
    const sections = [
      displayName ? `${renderSharedAiIcon(this.icon)} <b>${displayName}</b>` : renderSharedAiIcon(this.icon)
    ];
    if (this.request) {
      sections.push(
        tgBold("\u601D\u8003"),
        tgBlockquote(redactText(truncate2(this.request, 800), this.provider), true)
      );
    }
    const statusHtml = [
      tgEscape(redactText(this.state, this.provider)),
      "",
      [
        `\u6A21\u578B\uFF1A<code>${model}</code>`,
        `token\uFF1A${tgEscape(usageTotal(this.usage))}`
      ].join(" | "),
      [
        `\u8F6E\u6B21\uFF1A${this.step}/${this.maxSteps}`,
        `\u5DE5\u4F5C\u533A\uFF1A${tgEscape(this.workspace.id)}`,
        `\u8017\u65F6\uFF1A${tgEscape(elapsed(this.startedAt))}`
      ].join(" | ")
    ].join("\n");
    sections.push(
      tgBold("\u72B6\u6001"),
      tgHtmlBlockquote(statusHtml, true)
    );
    if (this.latest) {
      sections.push(
        tgBold("\u6700\u8FD1\u89C2\u5BDF"),
        tgBlockquote(redactText(this.latest, this.provider), true)
      );
    }
    if (this.observations.length) {
      const header = this.toolCount > this.observations.length ? `\u5DE5\u5177\u8C03\u7528\uFF08\u6700\u8FD1 ${this.observations.length}/${this.toolCount}\uFF09` : `\u5DE5\u5177\u8C03\u7528\uFF08${this.toolCount}\uFF09`;
      sections.push(
        tgBold(header),
        tgBlockquote(redactText(this.observations.join("\n"), this.provider), true)
      );
    }
    if (this.plan?.items.length) {
      const planText = this.plan.items.map((item) => {
        const mark = item.status === "completed" ? "\u2713" : item.status === "in_progress" ? "\u2192" : "\xB7";
        return `${mark} ${item.step}`;
      }).join("\n");
      sections.push(
        tgBold("\u6267\u884C\u8BA1\u5212"),
        tgBlockquote(redactText(planText, this.provider), true)
      );
    }
    return sections.join("\n");
  }
  async render(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEditAt < 1e3) return;
    this.lastEditAt = now;
    this.anchor = await safeEdit(this.anchor, this.build(), { html: true });
  }
  async finish(answer, usage) {
    this.usage = usage || this.usage;
    const model = tgEscape(redactText(this.provider.model, this.provider));
    const headerHtml = [
      `\u6A21\u578B\uFF1A<code>${model}</code>`,
      `token\uFF1A${tgEscape(usageTotal(this.usage))}`,
      `\u8017\u65F6\uFF1A${tgEscape(elapsed(this.startedAt))}`,
      `\u5DE5\u4F5C\u533A\uFF1A${tgEscape(this.workspace.id)}`
    ].join(" | ");
    const headerPlain = [
      `\u6A21\u578B\uFF1A${this.provider.model}`,
      `token\uFF1A${usageTotal(this.usage)}`,
      `\u8017\u65F6\uFF1A${elapsed(this.startedAt)}`,
      `\u5DE5\u4F5C\u533A\uFF1A${this.workspace.id}`
    ].join(" | ");
    const answerText = redactText(answer.trim() || "\u5DF2\u7ED3\u675F\u672C\u8F6E\u4EFB\u52A1\u3002", this.provider);
    const chunks = splitMarkdownText(answerText);
    const firstHtml = [
      headerHtml,
      this.request ? `${tgBold("\u601D\u8003")}
${tgBlockquote(redactText(this.request, this.provider), true)}` : "",
      `${tgBold("\u56DE\u590D")}
${tgHtmlBlockquote(markdownToTelegramHtml(chunks[0]), true)}`
    ].join("\n");
    this.anchor = await safeEdit(this.anchor, firstHtml, {
      html: true,
      plainFallback: [
        headerPlain,
        this.request ? `\u601D\u8003
${this.request}` : "",
        `\u56DE\u590D
${chunks[0]}`
      ].filter(Boolean).join("\n\n")
    });
    for (const chunk of chunks.slice(1)) {
      const html = [
        headerHtml,
        `${tgBold("\u56DE\u590D")}
${tgHtmlBlockquote(markdownToTelegramHtml(chunk), true)}`
      ].join("\n");
      await safeReply(this.anchor, html, {
        html: true,
        plainFallback: `${headerPlain}

\u56DE\u590D
${chunk}`
      });
    }
  }
  async fail(message) {
    const prefix = this.aborted ? "\u4EFB\u52A1\u5DF2\u88AB\u4E2D\u65AD" : "\u672C\u8F6E\u6267\u884C\u51FA\u9519\u4E86";
    const detail = this.aborted ? `${message}\n\n\u5DF2\u5B8C\u6210 ${this.toolCount} \u6B21\u5DE5\u5177\u8C03\u7528\uFF0C\u7ED3\u679C\u4FDD\u7559\u5728\u5BF9\u8BDD\u8BB0\u5FC6\u4E2D\u3002` : message;
    await this.finish(`${prefix}\uFF1A${detail}`, this.usage);
  }
};
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "binary");
  return null;
}
function detectImageMime(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}
function documentName(message) {
  const attributes = message?.media?.document?.attributes || [];
  return String(attributes.map((item) => item?.fileName).find(Boolean) || "");
}
function safeFileName(name) {
  return (import_path3.basename(name || "attachment").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "attachment").slice(0, 120);
}
async function buildReplyContext(msg, workspace) {
  const reply = msg.replyTo?.replyToMsgId ? await msg.getReplyMessage().catch(() => null) : null;
  if (!reply) return { text: "", images: [], savedFiles: [] };
  const text = [];
  const images = [];
  const savedFiles = [];
  const replyText = String(reply.message || reply.text || "").trim();
  if (replyText) text.push(`\u5F15\u7528\u6D88\u606F\uFF1A
${replyText}`);
  if (!reply.media) return { text: text.join("\n\n"), images, savedFiles };
  const client = msg.client || await (0, import_globalClient2.getGlobalClient)().catch(() => null);
  if (!client?.downloadMedia) {
    text.push("\u5F15\u7528\u6D88\u606F\u5305\u542B\u5A92\u4F53\uFF0C\u4F46\u5F53\u524D\u5BA2\u6237\u7AEF\u65E0\u6CD5\u4E0B\u8F7D\u3002");
    return { text: text.join("\n\n"), images, savedFiles };
  }
  const document = reply.media?.document;
  const mime = String(document?.mimeType || "").toLowerCase();
  const size = Number(document?.size || 0);
  const isPhoto = reply.media instanceof import_teleproto.Api.MessageMediaPhoto || reply.media?.className === "MessageMediaPhoto";
  if (size > MAX_REPLY_DOWNLOAD) {
    text.push(`\u5F15\u7528\u6587\u4EF6\u8FC7\u5927\uFF0C\u672A\u4E0B\u8F7D\uFF1A${documentName(reply) || "\u672A\u77E5\u6587\u4EF6"}\uFF08${size} bytes\uFF09`);
    return { text: text.join("\n\n"), images, savedFiles };
  }
  const buffer = toBuffer(await client.downloadMedia(reply, {}).catch(() => null));
  if (!buffer) {
    text.push("\u5F15\u7528\u5A92\u4F53\u4E0B\u8F7D\u5931\u8D25\u3002");
    return { text: text.join("\n\n"), images, savedFiles };
  }
  const detected = detectImageMime(buffer) || mime;
  if (isPhoto || IMAGE_MIMES.has(detected)) {
    if (IMAGE_MIMES.has(detected)) {
      images.push({ mimeType: detected, base64: buffer.toString("base64") });
      text.push("\u5F15\u7528\u6D88\u606F\u5305\u542B\u56FE\u7247\uFF0C\u56FE\u7247\u5DF2\u63D0\u4F9B\u7ED9\u6A21\u578B\u3002");
    }
    return { text: text.join("\n\n"), images, savedFiles };
  }
  const inbox = import_path3.join(workspace.dir, "inbox");
  await import_fs3.promises.mkdir(inbox, { recursive: true });
  const fileName = `${Date.now()}_${safeFileName(documentName(reply) || "attachment")}`;
  const savedPath = import_path3.join(inbox, fileName);
  await import_fs3.promises.writeFile(savedPath, buffer);
  const workspacePath = `$workspace/inbox/${fileName}`;
  savedFiles.push(workspacePath);
  text.push(`\u5F15\u7528\u6587\u4EF6\u5DF2\u4FDD\u5B58\uFF1A${workspacePath}
\u7C7B\u578B\uFF1A${mime || "\u672A\u77E5"}
\u5927\u5C0F\uFF1A${buffer.length} bytes`);
  if ((TEXT_EXTENSIONS.test(fileName) || TEXT_MIMES.test(mime)) && buffer.length <= MAX_INLINE_TEXT) {
    text.push(`\u6587\u4EF6\u5185\u5BB9\uFF1A
\`\`\`
${buffer.toString("utf-8")}
\`\`\``);
  }
  return { text: text.join("\n\n"), images, savedFiles };
}
function findCommand(commandLine) {
  const normalized = commandLine.trim();
  return (0, import_pluginManager2.listCommands)().sort((left, right) => right.length - left.length).find((command) => normalized === command || normalized.startsWith(`${command} `)) || null;
}
function stripCommandPrefix(commandLine) {
  const trimmed = commandLine.trim();
  const matched = [...(0, import_pluginManager2.getPrefixes)()].sort((left, right) => right.length - left.length).find((prefix) => trimmed.startsWith(prefix));
  return matched ? trimmed.slice(matched.length).trim() : trimmed;
}
function cloneForCapture(msg, commandLine, outputs) {
  const clone = Object.create(Object.getPrototypeOf(msg));
  Object.assign(clone, msg);
  const prefix = (0, import_pluginManager2.getPrefixes)()[0] || ".";
  Object.defineProperty(clone, "message", { value: `${prefix}${commandLine}`, writable: true });
  Object.defineProperty(clone, "text", { value: `${prefix}${commandLine}`, writable: true });
  const capture = async (payload) => {
    const value = payloadText(payload).trim();
    if (value) outputs.push(value);
    return clone;
  };
  Object.defineProperty(clone, "edit", { value: capture, configurable: true });
  Object.defineProperty(clone, "reply", { value: capture, configurable: true });
  const originalClient = msg.client;
  if (originalClient && typeof originalClient === "object") {
    const proxy = new Proxy(originalClient, {
      get(target, prop, receiver) {
        if (prop === "sendMessage" || prop === "editMessage" || prop === "sendFile") {
          return async (_peer, payload) => await capture(payload);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    Object.defineProperty(clone, "client", { value: proxy, configurable: true });
  }
  return clone;
}
function looksPending(text) {
  return /正在|处理中|运行中|稍后|后台|已启动|请等待|please wait|running|pending/i.test(text);
}
async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function dispatchPluginCaptured(msg, commandLine) {
  const normalized = stripCommandPrefix(commandLine);
  const command = findCommand(normalized);
  if (!command) throw new Error(`\u672A\u77E5 TeleBox \u63D2\u4EF6\u547D\u4EE4\uFF1A${normalized}`);
  const outputs = [];
  const captured = cloneForCapture(msg, normalized, outputs);
  await (0, import_pluginManager2.dealCommandPluginWithMessage)({ cmd: command, msg: captured, trigger: msg });
  await wait(800);
  if (looksPending(outputs.join("\n"))) await wait(5e3);
  return outputs.filter((value, index) => index === 0 || value !== outputs[index - 1]).join("\n\n").trim();
}
async function showHtmlMessage(msg, html, plainFallback) {
  const plain = stripTelegramHtml(String(plainFallback != null ? plainFallback : html));
  if (plain.length > SAFE_MESSAGE_LIMIT) {
    const chunks = splitLongText(plain);
    let anchor = await safeEdit(msg, chunks[0]);
    for (const chunk of chunks.slice(1)) {
      anchor = await safeReply(anchor, chunk) || anchor;
    }
    return;
  }
  await safeEdit(msg, html, { html: true, plainFallback: plain });
}
async function showPreformattedMessage(msg, title, content) {
  const chunks = splitLongText(content || "\uFF08\u7A7A\uFF09", 3e3);
  let anchor = await safeEdit(
    msg,
    `${tgBold(title)}
<pre>${tgEscape(chunks[0] || "\uFF08\u7A7A\uFF09")}</pre>`,
    { html: true, plainFallback: `${title}
${chunks[0] || "\uFF08\u7A7A\uFF09"}` }
  );
  for (const chunk of chunks.slice(1)) {
    anchor = await safeReply(anchor, `<pre>${tgEscape(chunk)}</pre>`, {
      html: true,
      plainFallback: chunk
    }) || anchor;
  }
}

// plugins/agent/main.ts
var prefixes = (0, import_pluginManager3.getPrefixes)();
var mainPrefix = prefixes[0] || ".";
var MAX_WORKSPACE_LIST = 200;
var SUBCOMMANDS = {
  // 每个子命令一组别名：第一项是“首选英文键”（易记），其余为兼容别名。
  // 既保留旧中文别名（肌肉记忆），也新增英文别名，逐步淘汰难记的拼音缩写。
  help: /* @__PURE__ */ new Set(["help", "?", "bz", "\u5E2E\u52A9"]),
  config: /* @__PURE__ */ new Set(["config", "pz", "\u914D\u7F6E"]),
  commands: /* @__PURE__ */ new Set(["commands", "gj", "\u547D\u4EE4"]),
  name: /* @__PURE__ */ new Set(["name", "mc", "\u540D\u79F0"]),
  steps: /* @__PURE__ */ new Set(["steps", "sl", "\u6B65\u6570"]),
  timeout: /* @__PURE__ */ new Set(["timeout", "cs", "\u8D85\u65F6"]),
  permission: /* @__PURE__ */ new Set(["perms", "permission", "qx", "\u6743\u9650"]),
  conversation: /* @__PURE__ */ new Set(["history", "dh", "conversation", "\u5BF9\u8BDD"]),
  newConversation: /* @__PURE__ */ new Set(["reset", "new", "xj", "\u65B0\u5EFA"]),
  contextLimit: /* @__PURE__ */ new Set(["context", "sx", "\u4E0A\u6587"]),
  workspace: /* @__PURE__ */ new Set(["workspace", "gz", "\u5DE5\u4F5C"]),
  files: /* @__PURE__ */ new Set(["files", "lb", "\u6587\u4EF6"]),
  deleteFile: /* @__PURE__ */ new Set(["rm", "sc", "del", "delete", "\u5220\u9664"]),
  ask: /* @__PURE__ */ new Set(["ask", "tw", "\u8BE2\u95EE"]),
  runPlugin: /* @__PURE__ */ new Set(["run", "zx", "\u6267\u884C"]),
  runSystem: /* @__PURE__ */ new Set(["sys", "xt", "system", "\u7CFB\u7EDF"]),
  withContext: /* @__PURE__ */ new Set(["ctx", "s", "\u5E26\u6587"]),
  ai: /* @__PURE__ */ new Set(["ai", "llm", "\u6A21\u578B"])
};
function splitBody(message) {
  const text = String(message || "").trim();
  const firstSpace = text.search(/\s/);
  return firstSpace < 0 ? "" : text.slice(firstSpace + 1).trim();
}
function compact(text, max = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}
function parseTimeout(value) {
  const match = value.trim().toLowerCase().match(
    /^(\d+(?:\.\d+)?)\s*(ms|毫秒|s|sec|秒|m|min|分钟|h|hr|小时)?$/
  );
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] || "m";
  const factor = unit === "ms" || unit === "\u6BEB\u79D2" ? 1 : ["s", "sec", "\u79D2"].includes(unit) ? 1e3 : ["h", "hr", "\u5C0F\u65F6"].includes(unit) ? 36e5 : 6e4;
  return Math.min(864e5, Math.max(1e4, Math.round(amount * factor)));
}
function formatDuration(ms) {
  const minutes = ms / 6e4;
  return Number.isInteger(minutes) ? `${minutes} \u5206\u949F` : `${minutes.toFixed(1)} \u5206\u949F`;
}
function scopeName(scope) {
  return scope === "system" ? "\u7CFB\u7EDF\u7EA7" : "TeleBox";
}
function scopeCommand(scope) {
  return `${mainPrefix}${scope === "system" ? "sysagent" : "agent"}`;
}
function menuSection(title, rows) {
  return [
    tgBold(title),
    ...rows.map(
      ([command, description]) => `${tgCode(command)} ${tgEscape(description)}`
    )
  ].join("\n");
}
function infoCard(title, rows) {
  return [
    tgBold(title),
    tgHtmlBlockquote(
      rows.map(([label, value]) => `${tgEscape(label)}\uFF1A${tgCode(value)}`).join("\n")
    )
  ].join("\n");
}
function successCard(title, detail = "") {
  return [tgBold(`\u2705 ${title}`), detail ? tgBlockquote(detail) : ""].filter(Boolean).join("\n");
}
function errorCard(message) {
  return [tgBold("\u274C \u6267\u884C\u5931\u8D25"), tgBlockquote(message, true)].join("\n");
}
function helpText(scope, displayName = "") {
  const prefix = scopeCommand(scope);
  const other = scope === "system" ? `${mainPrefix}agent` : `${mainPrefix}sysagent`;
  const alias = (en, cn) => `${en} / ${tgEscape(cn)}`;
  return [
    displayName ? `<b>${tgEscape(displayName)}</b> \u00B7 ${tgEscape(scopeName(scope))}\u667A\u80FD\u4F53` : `<b>${tgEscape(scopeName(scope))}\u667A\u80FD\u4F53</b>`,
    tgBlockquote("\u8BF7\u6C42\u4E00\u822C\u8BDD\u3001\u53EF\u6307\u4EE4\u3002\u547D\u4EE4\u4E3A\u82F1\u6587\u5173\u952E\u8BCD\uFF0C\u539F\u62FC\u97F3/\u4E2D\u6587\u522B\u540D\u4ECD\u517C\u5BB9\u3002"),
    menuSection("\u667A\u80FD\u4F53", [
      [`${prefix} <\u9700\u6C42>`, "\u6267\u884C\u667A\u80FD\u4F53\u8BF4\u660E\uFF08\u81EA\u52A8\u6309\u4E0A\u4E0B\u6587\u4EF6\uFF09"],
      [
        `${scope === "system" ? `${mainPrefix}sysplan` : `${mainPrefix}plan`} <\u9700\u6C42>`,
        "\u590D\u6742\u6A21\u5F0F\uFF1A\u5148\u5217\u51FA\u518D\u6267\u884C"
      ],
      [`${prefix} ${alias("ask", "\u95EE")} <\u95EE\u9898>`, "\u4EC5\u56DE\u7B54\uFF0C\u4E0D\u8C03\u7528\u5DE5\u5177"],
      [`${prefix} ${alias("reset", "\u65B0\u5EFA/\u91CD\u7F6E")}`, "\u91CD\u7F6E\u5BF9\u8BDD"],
      [`${prefix} ${alias("history", "\u5BF9\u8BDD")}`, "\u67E5\u770B\u5F53\u524D\u5BF9\u8BDD\u5386\u53F2"]
    ]),
    menuSection("\u5DE5\u4F5C\u533A", [
      [`${prefix} ${alias("workspace", "\u5DE5\u4F5C")} [<\u8DEF\u5F84>]`, "\u67E5\u770B\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55"],
      [`${prefix} ${alias("files", "\u6587\u4EF6")} [<\u9875\u6570>]`, "\u5217\u51FA\u5DE5\u4F5C\u533A\u6587\u4EF6"],
      [`${prefix} ${alias("rm", "\u5220\u9664")} <\u6587\u4EF6>`, "\u5220\u9664\u5DE5\u4F5C\u533A\u6587\u4EF6"],
      [
        scope === "telebox" ? `${prefix} ${alias("run", "\u8FD0\u884C")} <\u63D2\u4EF6\u547D\u4EE4>` : `${prefix} ${alias("sys", "\u7CFB\u7EDF")} <\u7CFB\u7EDF\u547D\u4EE4>`,
        scope === "telebox" ? "\u901A\u8FC7 TeleBox \u8C03\u7528\u63D2\u4EF6" : "\u76F4\u63A5\u6267\u884C\u7CFB\u7EDF\u547D\u4EE4"
      ]
    ]),
    menuSection("\u914D\u7F6E", [
      [`${prefix} ${alias("config", "\u914D\u7F6E")}`, "\u67E5\u770B\u5F53\u524D\u6A21\u578B\u4E0E\u8FD0\u884C\u914D\u7F6E"],
      [`${prefix} ${alias("name", "\u540D\u79F0")} <\u540D\u79F0>`, `\u8BBE\u7F6E\u667A\u80FD\u4F53\u540D\u79F0\uFF1B${alias("name reset", "\u6E05\u9664")}\u6E05\u9664`],
      [`${prefix} ${alias("steps", "\u6B65\u6570")} <\u6B65\u6570>`, `\u8BBE\u7F6E\u6700\u5927\u667A\u80FD\u6B65\u6570\uFF0C\u8303\u56F4 1-${MAX_AGENT_STEPS}`],
      [`${prefix} ${alias("timeout", "\u8D85\u65F6")} <\u65F6\u95F4>`, "\u8BBE\u7F6E\u6A21\u578B/\u547D\u4EE4\u8D85\u65F6\uFF0C\u4F8B\u5982 2m\u621130s"],
      [`${prefix} ${alias("context", "\u4E0A\u6587")} <\u6761\u6570>`, `\u8BBE\u7F6E\u5BF9\u8BDD\u4E0A\u6587\u6761\u6570\uFF0C\u8303\u56F4 1-${MAX_CONTEXT_LIMIT}`],
      [`${prefix} ${alias("perms", "\u6743\u9650")}`, "\u67E5\u770B\u6743\u9650\u4ECB\u7EED"],
      [
        `${other} <\u9700\u6C42>`,
        `\u5207\u6362\u5230${scope === "system" ? "TeleBox \u667A\u80FD\u4F53" : "\u7CFB\u7EDF\u667A\u80FD\u4F53"}\u667A\u80FD\u4F53`
      ]
    ]),
    tgBold("\u8DEF\u5F84"),
    tgHtmlBlockquote(
      `\u9879\u76EE\u8DEF\u5F84\uFF1A${tgCode("$project/...")}\n\u5DE5\u4F5C\u533A\u8DEF\u5F84\uFF1A${tgCode("$workspace/...")}`
    )
  ].join("\n\n");
}
function formatWorkspaceList(root, current, entries) {
  return [
    infoCard("\u5DE5\u4F5C\u533A\u6587\u4EF6", [
      ["\u76EE\u5F55", root],
      ["\u67E5\u770B\u8303\u56F4", current || "."],
      ["\u6570\u91CF", String(entries.length)]
    ]),
    tgBold("\u6587\u4EF6\u5217\u8868"),
    tgBlockquote(entries.join("\n") || "\u6682\u65E0\u6587\u4EF6\u3002", true)
  ].join("\n\n");
}
async function collectWorkspaceEntries(root, current, output = []) {
  if (output.length >= MAX_WORKSPACE_LIST) return output;
  const items = await import_fs4.promises.readdir(current, { withFileTypes: true });
  items.sort((left, right) => left.name.localeCompare(right.name));
  for (const item of items) {
    if (output.length >= MAX_WORKSPACE_LIST) break;
    const absolute = import_path4.join(current, item.name);
    const relative = import_path4.relative(root, absolute);
    if (item.isDirectory()) {
      output.push(`${relative}/`);
      await collectWorkspaceEntries(root, absolute, output);
    } else if (item.isFile()) {
      const stat = await import_fs4.promises.stat(absolute);
      output.push(`${relative} (${stat.size} bytes)`);
    }
  }
  return output;
}
function directExec(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    (0, import_child_process2.exec)(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          durationMs: Date.now() - startedAt
        });
      }
    );
  });
}
var AgentPlugin = class extends Plugin {
  description = "TeleBox 编程智能体：.agent/.plan 项目级、.sysagent/.sysplan 系统级。可读写文件、运行命令、调用插件。";
  constructor() {
    super(...arguments);
    this.description = async () => helpText("telebox", getDisplayName(await readConfig()));
    this.ignoreEdited = true;
    this.cmdHandlers = {
      agent: async (msg) => await this.handle(msg, "telebox", false),
      plan: async (msg) => await this.handle(msg, "telebox", true),
      sysagent: async (msg) => await this.handle(msg, "system", false),
      sysplan: async (msg) => await this.handle(msg, "system", true)
    };
  }
  setup(context) {
    this.abortSignal = context.signal;
  }
  cleanup() {
    this.abortSignal = void 0;
  }
  async handle(msg, scope, planFirst) {
    try {
      const body = splitBody(msg.message || msg.text || "");
      const config = await readConfig();
      const displayName = getDisplayName(config);
      this.name = displayName || void 0;
      if (!body || SUBCOMMANDS.help.has(body.toLowerCase())) {
        await showHtmlMessage(msg, helpText(scope, displayName));
        return;
      }
      const [modeRaw, ...rest] = body.split(/\s+/g);
      const mode = modeRaw.toLowerCase();
      const value = rest.join(" ").trim();
      if (SUBCOMMANDS.config.has(mode)) return await this.showConfig(msg, scope);
      if (SUBCOMMANDS.commands.has(mode)) return await this.showCommands(msg);
      if (SUBCOMMANDS.name.has(mode)) return await this.setName(msg, value);
      if (SUBCOMMANDS.steps.has(mode)) return await this.setSteps(msg, scope, value);
      if (SUBCOMMANDS.timeout.has(mode)) return await this.setTimeout(msg, scope, value);
      if (SUBCOMMANDS.contextLimit.has(mode)) return await this.setContextLimit(msg, scope, value);
      if (SUBCOMMANDS.permission.has(mode)) return await this.showPermission(msg, scope);
      if (SUBCOMMANDS.conversation.has(mode)) return await this.showConversation(msg, scope);
      if (SUBCOMMANDS.newConversation.has(mode)) return await this.newConversation(msg, scope);
      if (SUBCOMMANDS.workspace.has(mode)) return await this.workspaceCommand(msg, scope, value);
      if (SUBCOMMANDS.files.has(mode)) return await this.listWorkspace(msg, scope, value);
      if (SUBCOMMANDS.deleteFile.has(mode)) return await this.deleteWorkspaceFile(msg, scope, value);
      if (SUBCOMMANDS.ai.has(mode)) return await this.handleAi(msg, scope, value);
      if (scope === "telebox" && SUBCOMMANDS.runPlugin.has(mode)) {
        if (!value) throw new Error(`\u7528\u6CD5\uFF1A${mainPrefix}agent run <\u63D2\u4EF6\u547D\u4EE4>`);
        const output = await dispatchPluginCaptured(msg, value);
        await showHtmlMessage(
          msg,
          output || successCard("\u63D2\u4EF6\u547D\u4EE4\u5DF2\u6267\u884C", value)
        );
        return;
      }
      if (scope === "system" && SUBCOMMANDS.runSystem.has(mode)) {
        if (!value) throw new Error(`\u7528\u6CD5\uFF1A${mainPrefix}sysagent sys <\u7CFB\u7EDF\u547D\u4EE4>`);
        await this.runDirectSystemCommand(msg, value);
        return;
      }
      if (scope === "telebox" && SUBCOMMANDS.runSystem.has(mode)) {
        await showHtmlMessage(
          msg,
          [
            tgBold("\u7CFB\u7EDF\u7EA7\u547D\u4EE4\u5165\u53E3"),
            tgHtmlBlockquote(`\u8BF7\u7528 ${tgCode(`${mainPrefix}sysagent sys <\u547D\u4EE4>`)}`)
          ].join("\n")
        );
        return;
      }
      const answerOnly = SUBCOMMANDS.ask.has(mode);
      const prompt = answerOnly || SUBCOMMANDS.withContext.has(mode) ? value : body;
      await this.run(msg, prompt, {
        scope,
        answerOnly,
        planFirst
      });
    } catch (error) {
      await showHtmlMessage(msg, errorCard(formatProviderError(error)));
    }
  }
  async run(msg, prompt, options) {
    const session = await getSession(msg, options.scope);
    const provider = getProvider(session.config);
    const displayName = getDisplayName(session.config);
    if (!provider) {
      await showHtmlMessage(
        msg,
        [
          tgBold(displayName ? `${displayName} \u8FD8\u6CA1\u6709\u914D\u597D\u6A21\u578B` : "\u8FD8\u6CA1\u6709\u914D\u597D\u6A21\u578B"),
          tgHtmlBlockquote(
            `\u8BF7\u5148\u7528 ${tgCode(`${scopeCommand(options.scope)} ai set <\u540D\u79F0> <\u5730\u5740> <\u5BC6\u94A5> <\u6A21\u578B>`)} \u6DFB\u52A0\u4F9B\u5E94\u5546\uFF0C\u518D\u8BD5 ${tgCode(scopeCommand(options.scope) + " <\u9700\u6C42>")}\u3002\n\u67E5\u770B\u5DF2\u6709\u4F9B\u5E94\u5546\uFF1A${tgCode(`${scopeCommand(options.scope)} ai list`)}`
          )
        ].join("\n")
      );
      return;
    }
    const reply = await buildReplyContext(msg, session.workspace);
    if (!prompt.trim() && !reply.text && !reply.images.length) {
      await showHtmlMessage(
        msg,
        `${tgBold("\u7528\u6CD5")}
${tgBlockquote(`${scopeCommand(options.scope)} <\u9700\u6C42>`)}`
      );
      return;
    }
    const storedPrompt = prompt.trim() || "\u8BF7\u5904\u7406\u5F15\u7528\u6D88\u606F\u6216\u9644\u4EF6\u3002";
    const userContent = [
      "[\u672C\u8F6E\u8BF7\u6C42]\n\u4EE5\u4E0B\u662F\u7528\u6237\u5728\u672C\u8F6E\u5E0C\u671B\u4F60\u5B8C\u6210\u7684\u4EFB\u52A1\uFF0C\u8BF7\u76F4\u63A5\u6267\u884C\uFF0C\u4E0D\u8981\u91CD\u590D\u7CFB\u7EDF\u63D0\u793A\u3001\u4E0D\u8981\u63D0\u95EE\u9898\u786E\u8BA4\uFF1A",
      storedPrompt,
      reply.text ? `[\u5F15\u7528\u5185\u5BB9]\n\u7528\u6237\u5F15\u7528\u4E86\u4E0A\u4E00\u6761\u6D88\u606F\uFF0C\u5176\u6587\u672C\u5982\u4E0B\uFF08\u4EC5\u4F5C\u4E0A\u4E0B\u6587\uFF0C\u975E\u72EC\u7ACB\u6307\u4EE4\uFF09\uFF1A\n${reply.text}` : "",
      reply.savedFiles.length ? `[\u5DF2\u4FDD\u5B58\u9644\u4EF6]\n\u4EE5\u4E0B\u6587\u4EF6\u5DF2\u4E0B\u8F7D\u5230\u672C\u5730\u5DE5\u4F5C\u533A\uFF0C\u53EF\u7528\u5DE5\u5177\u76F4\u63A5\u8BBF\u95EE\uFF1A\n${reply.savedFiles.join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
    const status = new AgentStatus({
      msg,
      displayName,
      provider,
      workspace: session.workspace,
      maxSteps: getMaxSteps(session.config),
      icon: session.config.icon,
      request: storedPrompt
    });
    await status.render(true);
    const runtime = {
      msg,
      scope: options.scope,
      projectRoot: process.cwd(),
      workspace: session.workspace,
      provider,
      timeoutMs: getModelTimeout(session.config),
      commandTimeoutMs: getCommandTimeout(session.config),
      maxSteps: getMaxSteps(session.config),
      answerOnly: Boolean(options.answerOnly),
      planFirst: Boolean(options.planFirst),
      dispatchPlugin: async (command) => await dispatchPluginCaptured(msg, command),
      onPlanChange: async (plan) => await status.setPlan(plan),
      onToolStart: async (name, args) => await status.toolStart(name, args),
      onToolFinish: async (name, args, result) => await status.toolFinish(name, args, result)
    };
    try {
      const result = await runAgent({
        runtime,
        config: session.config,
        history: conversationToMessages(session.conversation),
        userMessage: { role: "user", content: userContent, images: reply.images },
        displayName,
        onStep: async (step) => {
          if (this.abortSignal?.aborted) {
            status.markAborted();
            throw new Error("\u63D2\u4EF6\u5DF2\u91CD\u8F7D\uFF0C\u672C\u8F6E\u4EFB\u52A1\u5DF2\u505C\u6B62");
          }
          status.setStep(step);
          await status.thinking();
        },
        onUsage: async (usage) => status.setUsage(usage)
      });
      await status.finish(result.answer, result.usage);
      await appendConversation(msg, options.scope, [
        { role: "user", content: storedPrompt },
        { role: "assistant", content: result.answer }
      ]);
    } catch (error) {
      const message = redactText(formatProviderError(error), provider);
      status.markAborted();
      await status.fail(message);
      await appendConversation(msg, options.scope, [
        { role: "user", content: storedPrompt },
        { role: "assistant", content: `\u6267\u884C\u5931\u8D25\uFF1A${message}` }
      ]).catch(() => void 0);
    }
  }
  async showConfig(msg, scope) {
    const config = await readConfig();
    const provider = getProvider(config);
    const providers = getProviders(config);
    await showHtmlMessage(
      msg,
      infoCard(
        getDisplayName(config) ? `${getDisplayName(config)} \u914D\u7F6E` : "\u667A\u80FD\u4F53\u914D\u7F6E",
        [
          ["\u8303\u56F4", scopeName(scope)],
          ["\u5F53\u524D\u4F9B\u5E94\u5546", provider ? `${provider.name} \u00B7 ${provider.model}` : "\u672A\u914D\u7F6E"],
          ["\u63A5\u53E3\u7C7B\u578B", provider?.api_interface || provider?.type || "\u672A\u914D\u7F6E"],
          ["\u63A5\u53E3\u5730\u5740", provider?.base_url || "\u672A\u914D\u7F6E"],
          ["\u5DF2\u4FDD\u5B58\u4F9B\u5E94\u5546", String(providers.length)],
          ["\u6700\u5927\u667A\u80FD\u6B65\u6570", String(getMaxSteps(config))],
          ["\u6A21\u578B\u8D85\u65F6", formatDuration(getModelTimeout(config))],
          ["\u547D\u4EE4\u8D85\u65F6", formatDuration(getCommandTimeout(config))],
          ["\u5BF9\u8BDD\u8BB0\u5FC6", `${getContextLimit(config)} \u6761\uFF08\u81EA\u52A8\u52A0\u8F7D\uFF09`],
          ["\u6570\u636E\u7248\u672C", `v${config.agent_schema_version || 2}`]
        ]
      )
    );
  }
  async handleAi(msg, scope, value) {
    const parts = String(value || "").trim().split(/\s+/g).filter(Boolean);
    const sub = (parts.shift() || "list").toLowerCase();
    const prefix = scopeCommand(scope);
    try {
      if (sub === "set" || sub === "add") {
        const [name, baseUrl, apiKey, model, iface] = parts;
        if (!name || !baseUrl || !apiKey || !model) {
          throw new Error(`\u7528\u6CD5\uFF1A${prefix} ai set <\u540D\u79F0> <\u5730\u5740> <\u5BC6\u94A5> <\u6A21\u578B> [\u63A5\u53E3]\u3002\u63A5\u53E3\u53EF\u7701\u7565\uFF08\u6839\u636E\u5730\u5740/\u6A21\u578B\u81EA\u52A8\u8BC6\u522B\uFF09\uFF1Aopenai / anthropic / gemini`);
        }
        await setProvider(name, {
          base_url: baseUrl.replace(/\/+$/, ""),
          api_key: apiKey,
          model,
          api_interface: iface ? iface.toLowerCase() : void 0
        });
        const provider = await getProvider(await readConfig());
        await showHtmlMessage(
          msg,
          successCard(
            "\u4F9B\u5E94\u5546\u5DF2\u4FDD\u5B58",
            `${name} \u00B7 ${model}\n\u63A5\u53E3\uFF1A${provider?.api_interface || "openai"}\n\u5730\u5740\uFF1A${baseUrl}\n\n${name === (await readConfig()).active_provider ? "\u5DF2\u81EA\u52A8\u8BBE\u4E3A\u5F53\u524D\u4F9B\u5E94\u5546" : `\u5207\u6362\u8BF7\u7528 ${tgCode(prefix + " ai use " + name)}`}`
          )
        );
        return;
      }
      if (sub === "use" || sub === "switch") {
        const [name] = parts;
        if (!name) throw new Error(`\u7528\u6CD5\uFF1A${prefix} ai use <\u540D\u79F0>`);
        const config = await readConfig();
        if (!config.ai_providers?.[name]) throw new Error(`\u627E\u4E0D\u5230\u4F9B\u5E94\u5546\uFF1A${name}\uFF08${prefix} ai list \u67E5\u770B\u5168\u90E8\uFF09`);
        await updateConfig((c) => { c.active_provider = name; });
        await showHtmlMessage(msg, successCard("\u5DF2\u5207\u6362\u4F9B\u5E94\u5546", `${name} \u00B7 ${config.ai_providers[name].model}`));
        return;
      }
      if (sub === "del" || sub === "delete" || sub === "rm") {
        const [name] = parts;
        if (!name) throw new Error(`\u7528\u6CD5\uFF1A${prefix} ai del <\u540D\u79F0>`);
        const config = await readConfig();
        if (!config.ai_providers?.[name]) throw new Error(`\u627E\u4E0D\u5230\u4F9B\u5E94\u5546\uFF1A${name}`);
        await removeProvider(name);
        await showHtmlMessage(msg, successCard("\u5DF2\u5220\u9664\u4F9B\u5E94\u5546", name));
        return;
      }
      // list (default)
      const config = await readConfig();
      const providers = getProviders(config);
      if (!providers.length) {
        await showHtmlMessage(
          msg,
          infoCard("\u6682\u65E0\u4F9B\u5E94\u5546", [
            ["\u6DFB\u52A0\u65B9\u5F0F", `${prefix} ai set <\u540D\u79F0> <\u5730\u5740> <\u5BC6\u94A5> <\u6A21\u578B>`],
            ["\u793A\u4F8B", `${prefix} ai set openai https://api.openai.com sk-xxx gpt-4o`]
          ])
        );
        return;
      }
      const rows = providers.map((p) => {
        const active = p.name === config.active_provider ? " \u2705" : "";
        return `${tgCode(p.name)}${active}\n  ${tgEscape(p.model)} \u00B7 ${tgEscape(p.api_interface || "openai")}\n  ${tgEscape(p.base_url || "")}`;
      });
      const current = getProvider(config);
      await showHtmlMessage(
        msg,
        [
          tgBold("\u5DF2\u4FDD\u5B58\u7684\u4F9B\u5E94\u5546"),
          tgHtmlBlockquote(rows.join("\n\n"), true),
          current ? `${tgBold("\u5F53\u524D\u4F7F\u7528")}\uFF1A${tgCode(current.name)} \u00B7 ${tgEscape(current.model)}` : tgBold("\u5F53\u524D\u672A\u9009\u62E9\u4F9B\u5E94\u5546"),
          tgHtmlBlockquote(`${tgCode(prefix + " ai use <\u540D\u79F0>")} \u5207\u6362\u00B7 ${tgCode(prefix + " ai del <\u540D\u79F0>")} \u5220\u9664`, true)
        ].join("\n")
      );
    } catch (error) {
      await showHtmlMessage(msg, errorCard(formatProviderError(error)));
    }
  }
  async showCommands(msg) {
    const blocked = /* @__PURE__ */ new Set(["agent", "plan", "sysagent", "sysplan", "ai", "exec"]);
    const rows = (0, import_pluginManager3.listCommands)().filter((command) => !blocked.has(command.toLowerCase())).map((command) => {
      const entry = (0, import_pluginManager3.getPluginEntry)(command);
      return `${tgCode(command)}${entry?.plugin?.name ? ` \u2014 ${tgEscape(entry.plugin.name)}` : ""}`;
    });
    await showHtmlMessage(
      msg,
      [
        tgBold("\u53EF\u8C03\u7528 TeleBox \u63D2\u4EF6"),
        tgHtmlBlockquote(rows.join("\n") || "\u6682\u65E0\u53EF\u8C03\u7528\u63D2\u4EF6\u3002", true)
      ].join("\n")
    );
  }
  async setName(msg, value) {
    if (!value) {
      const config = await readConfig();
      await showHtmlMessage(
        msg,
        infoCard("\u667A\u80FD\u540D\u79F0", [
          ["\u5F53\u524D\u540D\u79F0", getDisplayName(config) || "\u672A\u8BBE\u7F6E"],
          ["\u8BBE\u7F6E\u547D\u4EE4", `${mainPrefix}agent name <\u540D\u79F0>`],
          ["\u6E05\u9664\u547D\u4EE4", `${mainPrefix}agent name reset`]
        ])
      );
      return;
    }
    // 清空别名：reset / clear / qc / \u6E05\u9664 / \u91CD\u7F6E
    if (["reset", "clear", "qc", "\u6E05\u9664", "\u91CD\u7F6E", "\u91CD\u7F6E\u540D\u79F0"].includes(value.toLowerCase())) {
      await updateConfig((config) => {
        delete config.zn_name;
      });
      this.name = void 0;
      await showHtmlMessage(msg, successCard("\u5DF2\u6E05\u9664\u540D\u79F0"));
      return;
    }
    const name = compact(value, 32);
    // 放宽限制：仅当名称与已有命令关键字冲突时才拦截，允许 Cursor / Codex 等普通名称
    const reserved = /* @__PURE__ */ new Set([
      ...SUBCOMMANDS.help, ...SUBCOMMANDS.config, ...SUBCOMMANDS.commands,
      ...SUBCOMMANDS.name, ...SUBCOMMANDS.steps, ...SUBCOMMANDS.timeout,
      ...SUBCOMMANDS.permission, ...SUBCOMMANDS.conversation, ...SUBCOMMANDS.newConversation,
      ...SUBCOMMANDS.contextLimit, ...SUBCOMMANDS.workspace, ...SUBCOMMANDS.files,
      ...SUBCOMMANDS.deleteFile, ...SUBCOMMANDS.ask, ...SUBCOMMANDS.runPlugin,
      ...SUBCOMMANDS.runSystem, ...SUBCOMMANDS.withContext
    ]);
    if (reserved.has(name.toLowerCase())) {
      throw new Error("\u540D\u79F0\u4E0D\u80FD\u4E0E\u547D\u4EE4\u5173\u952E\u5B57\u51B2\u7A77\uFF0C\u8BF7\u6362\u4E00\u4E2A");
    }
    await updateConfig((config) => {
      config.zn_name = name;
    });
    this.name = name;
    await showHtmlMessage(msg, successCard("\u667A\u80FD\u540D\u79F0\u5DF2\u8BBE\u7F6E", name));
  }
  async setSteps(msg, scope, value) {
    if (!value) {
      const config = await readConfig();
      await showHtmlMessage(
        msg,
        infoCard("\u667A\u80FD\u6B65\u6570", [
            ["\u5F53\u524D\u6B65\u6570", String(getMaxSteps(config))],
            ["\u8BBE\u7F6E\u547D\u4EE4", `${scopeCommand(scope)} steps <1-${MAX_AGENT_STEPS}`]
        ])
      );
      return;
    }
    const steps = Math.min(MAX_AGENT_STEPS, Math.max(1, Number.parseInt(value, 10) || 0));
    if (!steps) throw new Error("\u8F6E\u6570\u5FC5\u987B\u662F\u6B63\u6574\u6570");
    await updateConfig((config) => {
      config.max_agent_steps = steps;
    });
    await showHtmlMessage(msg, successCard("\u6700\u5927\u667A\u80FD\u4F53\u8F6E\u6570\u5DF2\u66F4\u65B0", `${steps} \u8F6E`));
  }
  async setTimeout(msg, scope, value) {
    if (!value) {
      const config = await readConfig();
      await showHtmlMessage(
        msg,
        infoCard("\u8D85\u65F6\u8BBE\u7F6E", [
          ["\u6A21\u578B\u8D85\u65F6", formatDuration(getModelTimeout(config))],
          ["\u547D\u4EE4\u8D85\u65F6", formatDuration(getCommandTimeout(config))],
          ["\u8BBE\u7F6E\u547D\u4EE4", `${scopeCommand(scope)} timeout 2m`]
        ])
      );
      return;
    }
    const timeout = parseTimeout(value);
    if (!timeout) throw new Error("\u8D85\u65F6\u683C\u5F0F\u65E0\u6548\uFF0C\u4F8B\u5982 30s\u30012m\u30011h");
    await updateConfig((config) => {
      config.timeout = timeout;
      config.system_timeout = timeout;
    });
    await showHtmlMessage(
      msg,
      successCard("\u6A21\u578B\u548C\u547D\u4EE4\u8D85\u65F6\u5DF2\u66F4\u65B0", formatDuration(timeout))
    );
  }
  async setContextLimit(msg, scope, value) {
    if (!value) {
      const config = await readConfig();
      await showHtmlMessage(
        msg,
        infoCard("\u4E0A\u4E0B\u6587", [
            ["\u5F53\u524D\u4E0A\u6587", `${getContextLimit(config)} \u6761`],
            ["\u8BBE\u7F6E\u547D\u4EE4", `${scopeCommand(scope)} context <1-${MAX_CONTEXT_LIMIT}`]
        ])
      );
      return;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("\u8BB0\u5FC6\u6761\u6570\u5FC5\u987B\u662F\u6B63\u6574\u6570");
    const limit = Math.min(MAX_CONTEXT_LIMIT, Math.max(1, parsed));
    await updateConfig((config) => {
      config.conversation_context_limit = limit;
    });
    await showHtmlMessage(
      msg,
      successCard("\u5BF9\u8BDD\u8BB0\u5FC6\u5DF2\u66F4\u65B0", `${limit} \u6761\uFF1B\u666E\u901A .agent/.sysagent \u4F1A\u81EA\u52A8\u52A0\u8F7D`)
    );
  }
  async showPermission(msg, scope) {
    await showHtmlMessage(
      msg,
      scope === "telebox" ? [
        tgBold("TeleBox \u9879\u76EE\u6A21\u5F0F\u6743\u9650"),
        tgBlockquote(
          [
            `\u9879\u76EE\u6839\u76EE\u5F55\uFF1A${process.cwd()}`,
            "\u6587\u4EF6\u5DE5\u5177\u53EA\u80FD\u8BBF\u95EE\u9879\u76EE\u76EE\u5F55\u548C\u5F53\u524D\u9694\u79BB\u5DE5\u4F5C\u533A\u3002",
            "\u7CFB\u7EDF\u5B89\u88C5\u3001\u8D26\u6237\u3001\u6CE8\u518C\u8868\u3001\u5173\u673A\u91CD\u542F\u53CA\u9AD8\u98CE\u9669\u9012\u5F52\u5220\u9664\u4F1A\u88AB\u62D2\u7EDD\u3002"
          ].join("\n"),
          true
        ),
        `\u6574\u673A\u64CD\u4F5C\u5165\u53E3\uFF1A${tgCode(`${mainPrefix}sysagent <\u9700\u6C42>`)}`
      ].join("\n") : [
        tgBold("\u7CFB\u7EDF\u7EA7\u6A21\u5F0F\u6743\u9650"),
        tgBlockquote(
          [
            "\u7EE7\u627F\u5F53\u524D TeleBox/Node \u8FDB\u7A0B\u7684\u64CD\u4F5C\u7CFB\u7EDF\u6743\u9650\u3002",
            "\u53EF\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\u548C\u7CFB\u7EDF\u547D\u4EE4\uFF0C\u4F46\u4E0D\u4F1A\u7ED5\u8FC7 UAC\u3001\u6587\u4EF6 ACL \u6216\u7CFB\u7EDF\u6743\u9650\u3002",
            "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650\u65F6\uFF0C\u5E94\u4EE5\u7BA1\u7406\u5458\u8EAB\u4EFD\u542F\u52A8 TeleBox\u3002"
          ].join("\n"),
          true
        )
      ].join("\n")
    );
  }
  async showConversation(msg, scope) {
    const session = await getSession(msg, scope);
    const preview = session.conversation.messages.slice(-6).map((item, index) => `${index + 1}. ${item.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}\uFF1A${compact(item.content, 180)}`);
    await showHtmlMessage(
      msg,
      [
        infoCard(`${scopeName(scope)}\u5BF9\u8BDD`, [
          ["\u4F1A\u8BDD ID", session.conversation.id],
          ["\u5DE5\u4F5C\u533A", session.workspace.id],
          ["\u76EE\u5F55", session.workspace.dir],
          [
            "\u8BB0\u5FC6",
            `${session.conversation.messages.length}/${getContextLimit(session.config)}`
          ]
        ]),
        tgBold("\u6700\u8FD1\u8BB0\u5FC6"),
        tgBlockquote(preview.join("\n") || "\u6682\u65E0\u8BB0\u5FC6\u3002", true),
        `\u6E05\u7A7A\u5F53\u524D\u5BF9\u8BDD\uFF1A${tgCode(`${scopeCommand(scope)} reset`)}`
      ].join("\n\n")
    );
  }
  async newConversation(msg, scope) {
    const id = await resetConversation(msg, scope);
    await showHtmlMessage(
      msg,
      successCard(`\u5DF2\u5F00\u542F\u65B0\u7684${scopeName(scope)}\u5BF9\u8BDD`, `\u4F1A\u8BDD ID\uFF1A${id}`)
    );
  }
  async workspaceCommand(msg, scope, value) {
    const session = await getSession(msg, scope);
    if (!value) {
      await showHtmlMessage(
        msg,
        infoCard("\u5F53\u524D\u5DE5\u4F5C\u533A", [
          ["\u7F16\u53F7", session.workspace.id],
          ["\u76EE\u5F55", session.workspace.dir],
          ["\u9879\u76EE", `${scopeCommand(scope)} workspace <1-999>`],
          ["\u5217\u6587\u4EF6", `${scopeCommand(scope)} files`]
        ])
      );
      return;
    }
    const [operation, ...rest] = value.split(/\s+/g);
    if (operation === "ls") {
      await showHtmlMessage(
        msg,
        infoCard("\u5DE5\u4F5C\u533A\u8DEF\u5F84", [["\u76EE\u5F55", session.workspace.dir]])
      );
      return;
    }
    if (operation === "files") {
      await this.listWorkspace(msg, scope, rest.join(" "));
      return;
    }
    if (operation === "cat") {
      const target = rest.join(" ").trim();
      if (!target) throw new Error(`\u7528\u6CD5\uFF1A${scopeCommand(scope)} workspace cat <\u6587\u4EF6>`);
      const file = resolveWorkspacePath(session.workspace, target);
      const stat = await import_fs4.promises.stat(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("\u6587\u4EF6\u4E0D\u662F\u8D85\u9650\u7684\u6587\u672C\u6587\u4EF6");
      await showPreformattedMessage(
        msg,
        `\u5DE5\u4F5C\u533A\u6587\u4EF6\uFF1A${target}`,
        await import_fs4.promises.readFile(file, "utf-8")
      );
      return;
    }
    if (operation === "send") {
      const target = rest.join(" ").trim();
      if (!target) throw new Error(`\u7528\u6CD5\uFF1A${scopeCommand(scope)} workspace send <\u6587\u4EF6>`);
      await this.sendWorkspaceFile(msg, session.workspace, target);
      return;
    }
    if (SUBCOMMANDS.deleteFile.has(operation)) {
      await this.deleteWorkspaceFile(msg, scope, rest.join(" "));
      return;
    }
    const id = normalizeWorkspaceId(value);
    if (!id) throw new Error("\u5DE5\u4F5C\u533A\u7F16\u53F7\u5FC5\u987B 1-999\uFF0C\u8BF7\u7528 workspace ls/files/cat/send/rm");
    const workspace = await setWorkspace(msg, scope, id);
    await showHtmlMessage(
      msg,
      successCard(
        `\u5DF2\u5207\u6362\u5230${scopeName(scope)}\u5DE5\u4F5C\u533A ${workspace.id}`,
        `\u76EE\u5F55\uFF1A${workspace.dir}`
      )
    );
  }
  async listWorkspace(msg, scope, value) {
    const session = await getSession(msg, scope);
    const target = resolveWorkspacePath(session.workspace, value || ".");
    const stat = await import_fs4.promises.stat(target);
    if (stat.isFile()) {
      await showHtmlMessage(
        msg,
        infoCard("\u5DE5\u4F5C\u533A\u6587\u4EF6", [
          ["\u6587\u4EF6", import_path4.relative(session.workspace.dir, target)],
          ["\u5927\u5C0F", `${stat.size} bytes`]
        ])
      );
      return;
    }
    if (!stat.isDirectory()) throw new Error("\u76EE\u6807\u4E0D\u662F\u6587\u4EF6\u6216\u76EE\u5F55");
    const entries = await collectWorkspaceEntries(session.workspace.dir, target);
    await showHtmlMessage(
      msg,
      formatWorkspaceList(
        session.workspace.dir,
        import_path4.relative(session.workspace.dir, target) || ".",
        entries
      )
    );
  }
  async deleteWorkspaceFile(msg, scope, value) {
    if (!value) throw new Error(`\u7528\u6CD5\uFF1A${scopeCommand(scope)} rm <\u5DE5\u4F5C\u533A\u6587\u4EF6>`);
    const session = await getSession(msg, scope);
    const target = resolveWorkspacePath(session.workspace, value);
    const stat = await import_fs4.promises.stat(target);
    if (!stat.isFile()) throw new Error("\u53EA\u80FD\u5220\u9664\u5DE5\u4F5C\u533A\u5185\u7684\u5355\u4E2A\u6587\u4EF6\uFF0C\u4E0D\u80FD\u5220\u9664\u76EE\u5F55");
    await import_fs4.promises.unlink(target);
    await showHtmlMessage(
      msg,
      successCard(
        "\u5DE5\u4F5C\u533A\u6587\u4EF6\u5DF2\u5220\u9664",
        `\u6587\u4EF6\uFF1A${import_path4.relative(session.workspace.dir, target)}
\u5927\u5C0F\uFF1A${stat.size} bytes`
      )
    );
  }
  async sendWorkspaceFile(msg, workspace, value) {
    const target = resolveWorkspacePath(workspace, value);
    const stat = await import_fs4.promises.stat(target);
    if (!stat.isFile()) throw new Error("\u53D1\u9001\u76EE\u6807\u4E0D\u662F\u6587\u4EF6");
    if (stat.size > 50 * 1024 * 1024) throw new Error("\u6587\u4EF6\u8D85\u8FC7 50 MB");
    const client = msg.client || await (0, import_globalClient3.getGlobalClient)();
    await client.sendFile(msg.peerId, {
      file: target,
      caption: `\u5DE5\u4F5C\u533A ${workspace.id}\uFF1A${import_path4.relative(workspace.dir, target)}`
    });
    await showHtmlMessage(
      msg,
      successCard("\u6587\u4EF6\u5DF2\u53D1\u9001", import_path4.relative(workspace.dir, target))
    );
  }
  async runDirectSystemCommand(msg, command) {
    const session = await getSession(msg, "system");
    const timeout = getCommandTimeout(session.config);
    await showHtmlMessage(
      msg,
      [
        tgBold("\u6B63\u5728\u6267\u884C\u7CFB\u7EDF\u547D\u4EE4"),
        tgBlockquote(compact(command, 240), true)
      ].join("\n")
    );
    const result = await directExec(command, session.workspace.dir, timeout);
    await showPreformattedMessage(
      msg,
      `\u7CFB\u7EDF\u547D\u4EE4\u7ED3\u679C \xB7 \u9000\u51FA\u7801 ${result.code}`,
      redactText(
        [
          `\u547D\u4EE4\uFF1A${command}`,
          `\u76EE\u5F55\uFF1A${session.workspace.dir}`,
          `\u8017\u65F6\uFF1A${result.durationMs}ms`,
          `stdout:
${result.stdout.trim() || "\uFF08\u7A7A\uFF09"}`,
          `stderr:
${result.stderr.trim() || "\uFF08\u7A7A\uFF09"}`
        ].join("\n"),
        getProvider(session.config) || void 0
      )
    );
  }
};
var main_default = new AgentPlugin();
export default main_default;
