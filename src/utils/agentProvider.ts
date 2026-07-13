import axios from "axios";
import type { AIProvider, ChatMessage, ToolCall, ToolSpec, Usage, ModelResponse } from "./agentTypes";

const MAX_OUTPUT_TOKENS = 8192;
const ANTHROPIC_VERSION = "2023-06-01";


function trimBase(url: string | undefined | null) {
  return String(url || "").trim().replace(/\/+$/g, "");
}
function stripKnownEndpoint(url: string) {
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
function hasVersionPath(url: string) {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(url);
  }
}
function endpoint(provider: AIProvider, kind: string) {
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
function providerInterface(provider: AIProvider) {
  const explicit = String(provider.type || provider.api_interface || "").trim().toLowerCase();
  if (explicit) return explicit;
  const hint = `${provider.name} ${provider.base_url}`.toLowerCase();
  if (hint.includes("anthropic") || hint.includes("claude")) return "anthropic";
  return "openai";
}
function requestAuth(provider: AIProvider) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const params: Record<string, string> = {};
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
function systemPrompt(messages: ChatMessage[]) {
  return messages.filter((message: ChatMessage) => message.role === "system").map((message: ChatMessage) => message.content).join("\n\n");
}
function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
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
function usageFromOpenAI(data: any) {
  const usage = data?.usage;
  if (!usage) return void 0;
  return {
    prompt: usage.prompt_tokens ?? usage.input_tokens,
    completion: usage.completion_tokens ?? usage.output_tokens,
    total: usage.total_tokens
  };
}
function usageFromGemini(data: any) {
  const usage = data?.usageMetadata;
  if (!usage) return void 0;
  return {
    prompt: usage.promptTokenCount,
    completion: usage.candidatesTokenCount,
    total: usage.totalTokenCount
  };
}
function usageFromAnthropic(data: any) {
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
function apiError(data: any) {
  const error = data?.error;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return "";
}
function openAIMessageText(content: any) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(
    (part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : ""
  ).join("\n").trim();
}
function openAITools(tools: ToolSpec[]) {
  return tools.map((tool: ToolSpec) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}
function toOpenAIChatMessages(messages: ChatMessage[]) {
  return messages.map((message: ChatMessage) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: message.content
      };
    }
    const base: any = { role: message.role };
    if (message.images?.length && message.role === "user") {
      base.content = [
        { type: "text", text: message.content },
        ...message.images.map((image: any) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` }
        }))
      ];
    } else {
      base.content = message.content || null;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      base.tool_calls = message.toolCalls.map((call: ToolCall) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }));
    }
    return base;
  });
}
async function callOpenAIChat(provider: AIProvider, messages: ChatMessage[], tools: ToolSpec[], timeoutMs: number) {
  const auth = requestAuth(provider);
  const response = await axios.post(
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
  const calls = (message.tool_calls || []).map((call: ToolCall, index: number) => ({
    id: String(call.id || `call_${Date.now()}_${index}`),
    name: String(call.function?.name || call.name || ""),
    arguments: parseArguments(call.function?.arguments ?? call.arguments)
  })).filter((call: ToolCall) => call.name);
  return {
    text: openAIMessageText(message.content),
    toolCalls: calls,
    usage: usageFromOpenAI(response.data)
  };
}
function toResponsesInput(messages: ChatMessage[]) {
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
    const content: any[] = [
      { type: contentType, text: message.content || "" }
    ];
    if (message.role === "user") {
      content.push(
        ...(message.images || []).map((image: any) => ({
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
async function callResponses(provider: AIProvider, messages: ChatMessage[], tools: ToolSpec[], timeoutMs: number) {
  const auth = requestAuth(provider);
  const response = await axios.post(
    endpoint(provider, "responses"),
    {
      model: provider.model,
      instructions: systemPrompt(messages),
      input: toResponsesInput(messages),
      ...tools.length ? {
        tools: tools.map((tool: ToolSpec) => ({
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
function anthropicContent(message: ChatMessage) {
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
function toAnthropicMessages(messages: ChatMessage[]) {
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
async function callAnthropic(provider: AIProvider, messages: ChatMessage[], tools: ToolSpec[], timeoutMs: number) {
  const response = await axios.post(
    endpoint(provider, "anthropic"),
    {
      model: provider.model,
      system: systemPrompt(messages),
      messages: toAnthropicMessages(messages),
      ...tools.length ? {
        tools: tools.map((tool: ToolSpec) => ({
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
function toGeminiContents(messages: ChatMessage[]) {
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
        ...(message.images || []).map((image: any) => ({
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
function toGeminiSchema(value: unknown): any {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== "object") return value;
  const record = value;
  const output: any = {};
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
async function callGemini(provider: AIProvider, messages: ChatMessage[], tools: ToolSpec[], timeoutMs: number) {
  const auth = requestAuth(provider);
  const response = await axios.post(
    endpoint(provider, "gemini"),
    {
      systemInstruction: { parts: [{ text: systemPrompt(messages) }] },
      contents: toGeminiContents(messages),
      ...tools.length ? {
        tools: [
          {
            functionDeclarations: tools.map((tool: ToolSpec) => ({
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
async function callModel(provider: AIProvider, messages: ChatMessage[], tools: ToolSpec[], timeoutMs: number) {
  const invoke = async (currentMessages: any, currentTools: any) => {
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
    const status = axios.isAxiosError(error) ? error.response?.status : void 0;
    const detail = formatProviderError(error);
    const toolCompatibilityError = tools.length > 0 && [400, 404, 422].includes(status || 0) && /(tool|function|schema|unknown field|unsupported|not support)/i.test(detail);
    if (!toolCompatibilityError) throw error;
    const fallbackMessages = messages.map(
      (message: ChatMessage, index: number) => index === 0 && message.role === "system" ? {
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
function isTransientError(error: any) {
  if (axios.isAxiosError(error)) {
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
async function withTransientRetry(task: any, attempts = 3) {
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
function addUsage(total: any, next: any) {
  if (!total && !next) return void 0;
  return {
    prompt: typeof total?.prompt === "number" || typeof next?.prompt === "number" ? (total?.prompt || 0) + (next?.prompt || 0) : void 0,
    completion: typeof total?.completion === "number" || typeof next?.completion === "number" ? (total?.completion || 0) + (next?.completion || 0) : void 0,
    total: typeof total?.total === "number" || typeof next?.total === "number" ? (total?.total || 0) + (next?.total || 0) : void 0
  };
}
function formatProviderError(error: any) {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    const message = apiError(data) || data?.message || error.message;
    const status = error.response?.status;
    return [status ? `HTTP ${status}` : "", message].filter(Boolean).join(": ");
  }
  return error instanceof Error ? error.message : String(error);
}


export { callModel, addUsage, formatProviderError };
