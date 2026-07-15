import { callModel, addUsage, formatProviderError } from "./agentProvider";
import { createToolRuntime, workspaceDir } from "./agentTools";
import { readConfig, getProvider, getModelTimeout, getCommandTimeout, getMaxSteps, getContextLimit, getDisplayName, getSession, conversationToMessages, appendConversation, getSkillText } from "./agentStore";
import type { AgentInput, RuntimeContext, ChatMessage, ToolCall, ToolResult, Usage, AIProvider, AgentScope, AgentOptions, AgentConfig, RunAgentResult, WorkspaceRef } from "./agentTypes";
import { getPlatform } from "./agentTypes";

// plugins/agent/agent.ts
function buildSystemPrompt(input: AgentInput) {
  const runtime = input.runtime!;
  const { displayName, config } = input;
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
      `当前工作区：${workspaceDir(runtime)}`,
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
    getSkillText(config!)
  ].filter(Boolean).join("\n\n");
}
function extractJson(text: string) {
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
function safeParseJson(value: unknown) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function legacyToolCall(text: string) {
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
  const actionMap: Record<string, string> = {
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
  const args: Record<string, string> = {};
  if (typeof parsed.command === "string") args.command = parsed.command;
  if (typeof parsed.path === "string") args.path = parsed.path;
  if (typeof parsed.content === "string") args.content = parsed.content;
  if (typeof parsed.query === "string") args.query = parsed.query;
  if (typeof parsed.caption === "string") args.caption = parsed.caption;
  if (typeof parsed.old_text === "string") args.old_text = parsed.old_text;
  if (typeof parsed.new_text === "string") args.new_text = parsed.new_text;
  return { call: { id: `legacy_${Date.now()}`, name: tool, arguments: args } };
}
function toolResultMessage(call: ToolCall, ok: boolean, content: unknown) {
  return {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: JSON.stringify({ ok, content })
  };
}
function fingerprint(call: ToolCall) {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}
async function runAgent(input: AgentInput): Promise<RunAgentResult> {
  const runtime = input.runtime!;
  const tools = createToolRuntime(runtime);
  const messages = [
    { role: "system", content: buildSystemPrompt(input) },
    ...(input.history || []),
    input.userMessage!
  ];
  let usage;
  const callCounts = /* @__PURE__ */ new Map();
  let lastObservation = "";
  const throwIfAborted = () => {
    if (runtime.signal?.aborted) {
      const reason = runtime.signal.reason;
      throw reason instanceof Error ? reason : new Error("任务已中断（插件重载或取消）");
    }
  };
  for (let step = 1; step <= runtime.maxSteps; step += 1) {
    throwIfAborted();
    await input.onStep?.(step);
    throwIfAborted();
    const turn = await callModel(
      runtime.provider,
      messages as ChatMessage[],
      tools.definitions,
      runtime.timeoutMs
    );
    usage = addUsage(usage, turn.usage);
    await input.onUsage?.(usage);
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
      throwIfAborted();
      const key = fingerprint(call);
      const count = (callCounts.get(key) || 0) + 1;
      callCounts.set(key, count);
      if (count > 3) {
        const content = "\u76F8\u540C\u7684\u5DE5\u5177\u8C03\u7528\u5DF2\u8FDE\u7EED 3 \u6B21\u4E14\u672A\u4EA7\u751F\u65B0\u8FDB\u5C55\uFF0C\u5DF2\u81EA\u52A8\u8DF3\u8FC7\u3002\u8BF7\u6362\u4E00\u79CD\u65B9\u6CD5\uFF1A\u5148\u8BFB\u53D6\u4E0A\u4E00\u6B21\u7684\u771F\u5B9E\u8FD4\u56DE\u5B9A\u4F4D\u6839\u56E0\uFF0C\u6216\u57FA\u4E8E\u73B0\u6709\u89C2\u5BDF\u7ED9\u51FA\u7ED3\u8BBA\uFF1B\u82E5\u786E\u5B9E\u65E0\u6CD5\u7EE7\u7EED\u8BF7\u660E\u8BF4\u539F\u56E0\u3002";
        messages.push(toolResultMessage(call, false, content));
        lastObservation = content;
        continue;
      }
      const result: ToolResult = await tools.execute(call.name, call.arguments);
      lastObservation = result.content;
      messages.push(toolResultMessage(call, result.ok, result.content));
    }
  }
  throwIfAborted();
  await input.onStep?.(runtime.maxSteps);
  messages.push({
    role: "user",
    content: [
      "\u5DF2\u8FBE\u5230\u672C\u8F6E\u5DE5\u5177\u8C03\u7528\u4E0A\u9650\uFF0C\u4E0D\u80FD\u518D\u8C03\u7528\u5DE5\u5177\u3002\u8BF7\u4EC5\u73B0\u6709\u771F\u5B9E\u89C2\u5BDF\u4E3A\u4F9D\u636E\uFF0C\u7ED9\u7528\u6237\u4E00\u4E2A\u6700\u7EC8\u72B6\u6001\uFF1A\u5DF2\u5B8C\u6210\u4EC0\u4E48\u3001\u9A8C\u8BC1\u7ED3\u679C\u3001\u5C1A\u672A\u5B8C\u6210\u4EC0\u4E48\u53CA\u539F\u56E0\u3002\u82E5\u9700\u7EE7\u7EED\u53EF\u8BA9\u7528\u6237\u7528 .plan \u91CD\u542F\u5E76\u8865\u5145\u6B65\u9AA4\u3002",
      "\u8BF7\u53EA\u6839\u636E\u5DF2\u7ECF\u53D1\u751F\u7684\u771F\u5B9E\u5DE5\u5177\u89C2\u5BDF\uFF0C\u7ED9\u7528\u6237\u4E00\u4E2A\u6700\u7EC8\u72B6\u6001\uFF1A\u5B8C\u6210\u4E86\u4EC0\u4E48\u3001\u9A8C\u8BC1\u7ED3\u679C\u3001\u5C1A\u672A\u5B8C\u6210\u4EC0\u4E48\u4EE5\u53CA\u539F\u56E0\u3002",
      lastObservation ? `\u6700\u8FD1\u89C2\u5BDF\uFF1A
${lastObservation}` : "\u672C\u8F6E\u6CA1\u6709\u53EF\u7528\u89C2\u5BDF\u3002"
    ].join("\n\n")
  });
  const finalTurn = await callModel(runtime.provider, messages as ChatMessage[], [], runtime.timeoutMs);
  usage = addUsage(usage, finalTurn.usage);
  await input.onUsage?.(usage);
  return {
    answer: finalTurn.text.trim() || `\u5DF2\u8FBE\u5230\u6700\u5927\u5DE5\u4F5C\u8F6E\u6570\uFF08${runtime.maxSteps}\uFF09\uFF0C\u65E0\u6CD5\u5728\u672C\u8F6E\u786E\u8BA4\u4EFB\u52A1\u5B8C\u6574\u5B8C\u6210\u3002\u6700\u8FD1\u89C2\u5BDF\uFF1A${lastObservation || "\u65E0"}`,
    usage
  };
}

// plugins/agent/telegram.ts
import import_fs3 = require("fs");
import import_path3 = require("path");
import import_globalClient2 = require("@utils/runtimeManager");
import import_pluginManager2 = require("@utils/pluginManager");
const SAFE_MESSAGE_LIMIT = 3900;
const MAX_REPLY_DOWNLOAD = 20 * 1024 * 1024;
const MAX_INLINE_TEXT = 6e4;
const IMAGE_MIMES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = /\.(txt|md|csv|json|jsonl|yaml|yml|toml|ini|cfg|conf|log|py|ts|js|jsx|tsx|sh|bat|ps1|html|htm|xml|sql|go|rs|java|c|cpp|h|cs|php|rb|swift|kt|env|properties)$/i;
const TEXT_MIMES = /^(text\/|application\/(json|javascript|xml|x-yaml|x-sh|x-python|toml|csv|sql|typescript))/i;
function tgEscape(text: string) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function tgCode(text: string) {
  return `<code>${tgEscape(text)}</code>`;
}
function tgBold(text: string) {
  return `<b>${tgEscape(text)}</b>`;
}
function tgBlockquote(text: string, expandable = false) {
  return `<blockquote${expandable ? " expandable" : ""}>${tgEscape(text || " ")}</blockquote>`;
}
function tgHtmlBlockquote(html: string, expandable = false) {
  return `<blockquote${expandable ? " expandable" : ""}>${html || " "}</blockquote>`;
}
function renderSharedAiIcon(icon: any) {
  return tgEscape(icon?.value || "\u{1F916}");
}
function stripTelegramHtml(text: string) {
  return String(text || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|blockquote|pre)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
}
function truncate2(text: string, max = SAFE_MESSAGE_LIMIT) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max - 18)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF09`;
}
function payloadText(payload: any) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload;
  for (const key of ["text", "message", "caption"]) {
    if (typeof record[key] === "string") return record[key];
  }
  if (record.file || record.files || record.media) return "\uFF08\u53D1\u9001\u4E86\u6587\u4EF6\u6216\u5A92\u4F53\uFF09";
  return "";
}
function redactText(text: string, provider: AIProvider) {
  let result = String(text || "");
  const secrets = [provider?.api_key, ...Object.entries(process.env).filter(([key, value]) => typeof value === "string" && /(key|token|secret|password|cookie|authorization)/i.test(key)).map(([, value]) => value as string)].filter((value): value is string => Boolean(value && value.length >= 8)).sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    const visible = secret.length > 12 ? `${secret.slice(0, 4)}\u2026${secret.slice(-4)}` : "***";
    result = result.split(secret).join(visible);
  }
  return result.replace(/\b(sk-[A-Za-z0-9._-]{10,})\b/g, (value) => `${value.slice(0, 4)}\u2026${value.slice(-4)}`).replace(
    /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (_match, prefix, value) => `${prefix}${String(value).slice(0, 4)}\u2026${String(value).slice(-4)}`
  );
}
async function safeEdit(msg: any, text: string, options: AgentOptions = {}) {
  return getPlatform().safeEdit(msg, text, options);
}
async function safeReply(msg: any, text: string, options: AgentOptions = {}) {
  return getPlatform().safeReply(msg, text, options);
}
function splitLongText(text: string, max = SAFE_MESSAGE_LIMIT) {
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
function splitMarkdownText(text: string, max = 3e3) {
  const lines = String(text || "").split(/\r?\n/);
  const chunks = [];
  let current: string[] = [];
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
function markdownToTelegramHtml(markdown: any) {
  let source = String(markdown || "");
  const blocks: any[] = [];
  const inlineCodes: any[] = [];
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
function usageTotal(usage: Usage) {
  if (typeof usage?.total === "number") return String(usage.total);
  const total = (usage?.prompt || 0) + (usage?.completion || 0);
  return total ? String(total) : "\u672A\u77E5";
}
function elapsed(startedAt: number) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1e3));
  if (seconds < 60) return `${seconds}\u79D2`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}\u5206${seconds % 60}\u79D2`;
}
function toolLabel(name: string) {
  return ({
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
  } as Record<string, string>)[name] || name;
}
function summarizeArgs(args: Record<string, unknown>) {
  for (const key of ["command", "path", "file", "target", "query", "url", "caption"]) {
    if (args[key] !== void 0) return truncate2(String(args[key]).replace(/\s+/g, " "), 180);
  }
  if (Array.isArray(args.items)) return `${args.items.length} \u4E2A\u8BA1\u5212\u6B65\u9AA4`;
  const keys = Object.keys(args);
  if (keys.length === 1) return truncate2(String(args[keys[0]]).replace(/\s+/g, " "), 180);
  return keys.join(", ") || "\u65E0\u53C2\u6570";
}
const AgentStatus = class {
  startedAt: any;
  step: any;
  state: any;
  latest: any;
  observations: any;
  toolCount: any;
  aborted: any;
  lastEditAt: any;
  anchor: any;
  displayName: any;
  provider: AIProvider;
  workspace: any;
  maxSteps: any;
  icon: any;
  request: any;
  usage?: Usage;
  plan: any;
  constructor(input: AgentInput) {
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
    this.provider = input.provider!;
    this.workspace = input.workspace;
    this.maxSteps = input.maxSteps;
    this.icon = input.icon;
    this.request = String(input.request || "").trim();
  }
  setStep(step: number) {
    this.step = step;
  }
  setUsage(usage?: Usage) {
    this.usage = usage;
  }
  async setPlan(plan: any) {
    this.plan = plan;
    this.state = "\u8BA1\u5212\u5DF2\u66F4\u65B0\uff0c\u9a6c\u4e0d\u505c\u6b65\u5730\u63a8\u8fdb\u2026";
    await this.render(true);
  }
  async thinking() {
    this.state = "\u6B63\u5728\u5206\u6790\u5F53\u524D\u60C5\u51B5\uFF0C\u51B3\u5B9A\u4E0B\u4E00\u6B65\u2026";
    await this.render();
  }
  async toolStart(name: string, args: Record<string, unknown>) {
    this.state = `${toolLabel(name)}\uFF1A${summarizeArgs(args)}`;
    await this.render(true);
  }
  async toolFinish(name: string, args: Record<string, unknown>, result: ToolResult) {
    const firstLine = result.content.split(/\r?\n/).find((line: string) => line.trim()) || "\u65E0\u8F93\u51FA";
    this.latest = `${result.ok ? "\u2713" : "\u2717"} ${toolLabel(name)}\uFF1A${summarizeArgs(args)}
${truncate2(firstLine, 220)}`;
    this.state = result.ok ? "\u5DF2\u62FF\u5230\u7ED3\u679C\uFF0C\u6B63\u5728\u63A8\u8FDB\u2026" : "\u8FD9\u6B65\u51FA\u4E86\u70B9\u72B6\u51B5\uFF0C\u6B63\u5728\u67E5\u539F\u56E0\u2026";
    await this.render(true);
  }
  markAborted() {
    this.aborted = true;
  }
  build(): string {
    const displayName = tgEscape(redactText(this.displayName, this.provider));
    const model = tgEscape(redactText(this.provider!.model, this.provider!));
    // Always bold title: 🤖TeleBox(-Next) Agent (custom zn_name overrides brand text)
    const titleLabel = displayName || "TeleBox Agent";
    const sections = [
      `<b>${renderSharedAiIcon(this.icon)}${titleLabel}</b>`
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
        `token\uFF1A${tgEscape(usageTotal(this.usage!))}`
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
      const planText = this.plan.items.map((item: any) => {
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
  async finish(answer: any, usage?: Usage) {
    this.usage = usage || this.usage;
    const model = tgEscape(redactText(this.provider!.model, this.provider!));
    const headerHtml = [
      `\u6A21\u578B\uFF1A<code>${model}</code>`,
      `token\uFF1A${tgEscape(usageTotal(this.usage!))}`,
      `\u8017\u65F6\uFF1A${tgEscape(elapsed(this.startedAt))}`,
      `\u5DE5\u4F5C\u533A\uFF1A${tgEscape(this.workspace.id)}`
    ].join(" | ");
    const headerPlain = [
      `\u6A21\u578B\uFF1A${this.provider!.model}`,
      `token\uFF1A${usageTotal(this.usage!)}`,
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
  async fail(message: string) {
    const prefix = this.aborted ? "\u4EFB\u52A1\u5DF2\u88AB\u4E2D\u65AD" : "\u672C\u8F6E\u6267\u884C\u51FA\u9519\u4E86";
    const detail = this.aborted ? `${message}\n\n\u5DF2\u5B8C\u6210 ${this.toolCount} \u6B21\u5DE5\u5177\u8C03\u7528\uFF0C\u7ED3\u679C\u4FDD\u7559\u5728\u5BF9\u8BDD\u8BB0\u5FC6\u4E2D\u3002` : message;
    await this.finish(`${prefix}\uFF1A${detail}`, this.usage);
  }
};
function toBuffer(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "binary");
  return null;
}
function detectImageMime(buffer: any) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}
function documentName(message: ChatMessage) {
  const attributes = message?.media?.document?.attributes || [];
  return String(attributes.map((item: any) => item?.fileName).find(Boolean) || "");
}
function safeFileName(name: string) {
  return (import_path3.basename(name || "attachment").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "attachment").slice(0, 120);
}
async function buildReplyContext(msg: any, workspace: any) {
  return getPlatform().buildReplyContext(msg, workspace);
}
function findCommand(commandLine: string) {
  const normalized = commandLine.trim();
  return (0, import_pluginManager2.listCommands)().sort((left, right) => right.length - left.length).find((command) => normalized === command || normalized.startsWith(`${command} `)) || null;
}
function stripCommandPrefix(commandLine: string) {
  const trimmed = commandLine.trim();
  const matched = [...(0, import_pluginManager2.getPrefixes)()].sort((left, right) => right.length - left.length).find((prefix) => trimmed.startsWith(prefix));
  return matched ? trimmed.slice(matched.length).trim() : trimmed;
}
function cloneForCapture(msg: any, commandLine: string, outputs: any) {
  const clone = Object.create(Object.getPrototypeOf(msg));
  Object.assign(clone, msg);
  const prefix = (0, import_pluginManager2.getPrefixes)()[0] || ".";
  Object.defineProperty(clone, "message", { value: `${prefix}${commandLine}`, writable: true });
  Object.defineProperty(clone, "text", { value: `${prefix}${commandLine}`, writable: true });
  const capture = async (payload: any) => {
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
          return async (_peer: any, payload: any) => await capture(payload);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    Object.defineProperty(clone, "client", { value: proxy, configurable: true });
  }
  return clone;
}
function looksPending(text: string) {
  return /正在|处理中|运行中|稍后|后台|已启动|请等待|please wait|running|pending/i.test(text);
}
async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function dispatchPluginCaptured(msg: any, commandLine: string) {
  const normalized = stripCommandPrefix(commandLine);
  const command = findCommand(normalized);
  if (!command) throw new Error(`\u672A\u77E5 TeleBox \u63D2\u4EF6\u547D\u4EE4\uFF1A${normalized}`);
  const outputs: string[] = [];
  const captured = cloneForCapture(msg, normalized, outputs);
  await (0, import_pluginManager2.dealCommandPluginWithMessage)({ cmd: command, msg: captured, trigger: msg });
  await wait(800);
  if (looksPending(outputs.join("\n"))) await wait(5e3);
  return outputs.filter((value, index) => index === 0 || value !== outputs[index - 1]).join("\n\n").trim();
}
async function showHtmlMessage(msg: any, html: any, plainFallback: any = void 0) {
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
async function showPreformattedMessage(msg: any, title: string, content: any) {
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


export {
  runAgent,
  AgentStatus,
  buildReplyContext,
  showHtmlMessage,
  showPreformattedMessage,
  dispatchPluginCaptured,
  buildSystemPrompt,
  safeReply,
  safeEdit,
  redactText,
  splitMarkdownText,
  markdownToTelegramHtml,
  splitLongText,
  stripTelegramHtml,
  tgEscape,
  tgCode,
  tgBold,
  tgBlockquote,
  tgHtmlBlockquote,
  renderSharedAiIcon,
  toolLabel,
  summarizeArgs,
  truncate2,
  usageTotal,
  elapsed,
  findCommand,
  stripCommandPrefix,
  cloneForCapture,
  looksPending,
  wait,
  documentName,
  safeFileName,
  detectImageMime,
  toBuffer,
};
