import type { RuntimeContext, CommandResult, ToolResult, AgentScope } from "./agentTypes";
import { getPlatform } from "./agentTypes";

// plugins/agent/tools.ts
import import_fs = require("fs");
import import_path = require("path");
import import_child_process = require("child_process");
import import_globalClient = require("@utils/runtimeManager");
import import_pluginManager = require("@utils/pluginManager");
const MAX_TOOL_OUTPUT = 2e4;
const MAX_TEXT_READ = 2 * 1024 * 1024;
const MAX_WRITE_SIZE = 4 * 1024 * 1024;
const MAX_SEND_SIZE = 50 * 1024 * 1024;
const MAX_LIST_ENTRIES = 300;
const MAX_TOOL_CALLS_PER_TURN = 8;
const BLOCKED_PLUGIN_COMMANDS = /* @__PURE__ */ new Set(["agent", "plan", "sysagent", "sysplan", "ai", "exec"]);
const OBJECT_SCHEMA = "object";
function schema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: OBJECT_SCHEMA,
    properties,
    required,
    additionalProperties: false
  };
}
const TOOL_DEFINITIONS = [
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
function truncate(text: string, max = MAX_TOOL_OUTPUT) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max)}
\u2026\uFF08\u5DE5\u5177\u8F93\u51FA\u5DF2\u622A\u65AD\uFF09`;
}
function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value === void 0 ? fallback : String(value);
}
function asInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}
function within(root: string, target: string) {
  const relative = import_path.relative(import_path.resolve(root), import_path.resolve(target));
  return relative === "" || !relative.startsWith("..") && !import_path.isAbsolute(relative);
}
function workspaceDir(context: RuntimeContext): string {
  return context.workspace?.dir ?? context.projectRoot ?? ".";
}
function defaultRoot(context: RuntimeContext) {
  return context.scope === "telebox" ? context.projectRoot ?? "." : workspaceDir(context);
}
function resolveAgentPath(context: RuntimeContext, rawPath: unknown, fallback = ".") {
  let requested = asString(rawPath, fallback).trim().replace(/^['"]|['"]$/g, "") || fallback;
  let base = defaultRoot(context);
  if (/^(?:\$workspace|workspace:)(?:[\\/]|$)/i.test(requested)) {
    requested = requested.replace(/^(?:\$workspace|workspace:)[\\/]?/i, "");
    base = workspaceDir(context);
  } else if (/^(?:\$project|project:)(?:[\\/]|$)/i.test(requested)) {
    requested = requested.replace(/^(?:\$project|project:)[\\/]?/i, "");
    base = context.projectRoot ?? ".";
  }
  const resolved = import_path.resolve(base, requested || ".");
  if (context.scope === "telebox" && !within(context.projectRoot ?? ".", resolved) && !within(workspaceDir(context), resolved)) {
    throw new Error("TeleBox 智能体不能访问项目目录以外的路径；请使用 .sysagent 执行系统级任务");
  }
  return resolved;
}
function relativeDisplay(context: RuntimeContext, target: string) {
  if (within(context.projectRoot ?? ".", target)) {
    return import_path.relative(context.projectRoot ?? ".", target) || ".";
  }
  if (within(workspaceDir(context), target)) {
    return `$workspace/${import_path.relative(workspaceDir(context), target) || "."}`;
  }
  return target;
}
async function collectFiles(context: RuntimeContext, root: string, recursive: boolean, limit: number) {
  const output: string[] = [];
  const visit = async (directory: string) => {
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
function runProcess(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
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
function runRg(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
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
function assertCommandAllowed(command: string, scope: AgentScope) {
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
function stripPluginPrefix(commandLine: string) {
  const trimmed = commandLine.trim();
  const matched = [...(0, import_pluginManager.getPrefixes)()].sort((left, right) => right.length - left.length).find((prefix) => trimmed.startsWith(prefix));
  return matched ? trimmed.slice(matched.length).trim() : trimmed;
}
function formatCommandResult(command: string, cwd: string, result: CommandResult) {
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
function validatePlan(args: Record<string, any>) {
  if (!Array.isArray(args.items) || !args.items.length) {
    throw new Error("\u8BA1\u5212 items \u4E0D\u80FD\u4E3A\u7A7A");
  }
  const items = args.items.slice(0, 12).map((item: any) => {
    if (!item || typeof item !== "object") throw new Error("\u8BA1\u5212\u6B65\u9AA4\u683C\u5F0F\u65E0\u6548");
    const record = item;
    const step = asString(record.step).trim();
    const status = asString(record.status);
    if (!step || !["pending", "in_progress", "completed"].includes(status)) {
      throw new Error("\u8BA1\u5212\u6B65\u9AA4\u5FC5\u987B\u5305\u542B step \u548C\u6709\u6548 status");
    }
    return { step, status };
  });
  if (items.filter((item: any) => item.status === "in_progress").length > 1) {
    throw new Error("\u8BA1\u5212\u4E2D\u6700\u591A\u53EA\u80FD\u6709\u4E00\u4E2A in_progress \u6B65\u9AA4");
  }
  return { explanation: asString(args.explanation).trim() || void 0, items };
}
async function executeTool(context: RuntimeContext, name: string, args: Record<string, any>) {
  if (name === "update_plan") {
    const plan = validatePlan(args);
    await context.onPlanChange(plan);
    return {
      ok: true,
      title: "\u8BA1\u5212\u5DF2\u66F4\u65B0",
      content: [
        plan.explanation || "\u8BA1\u5212\u5DF2\u66F4\u65B0",
        ...plan.items.map((item: any, index: number) => `${index + 1}. [${item.status}] ${item.step}`)
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
    const result = await runRg(rgArgs, context.projectRoot ?? ".");
    return {
      ok: true,
      title: "搜索完成",
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
    assertCommandAllowed(command, context.scope ?? "private");
    const cwd = resolveAgentPath(context, args.cwd, defaultRoot(context));
    const stat = await import_fs.promises.stat(cwd);
    if (!stat.isDirectory()) throw new Error("cwd \u4E0D\u662F\u76EE\u5F55");
    const timeoutMs = asInt(args.timeout_ms, context.commandTimeoutMs ?? 12e4, 1e3, 864e5);
    const result: CommandResult = await runProcess(command, cwd, timeoutMs);
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
    const output = await context.dispatchPlugin(command, context.msg) as unknown as string;
    return {
      ok: true,
      title: "\u63D2\u4EF6\u5DF2\u6267\u884C",
      content: truncate(output || `\u63D2\u4EF6\u547D\u4EE4\u5DF2\u6267\u884C\uFF1A${command}\uFF08\u6CA1\u6709\u6355\u83B7\u5230\u6587\u672C\u8F93\u51FA\uFF09`)
    };
  }
  if (name === "send_file") {
    const target = resolveAgentPath(context, args.path);
    const stat = await import_fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("发送目标不是文件");
    if (stat.size <= 0) throw new Error("文件为空");
    if (stat.size > MAX_SEND_SIZE) throw new Error("文件超过 50 MB 发送上限");
    const client = context.msg.client || await (0, import_globalClient.getGlobalClient)();
    if (!client?.sendFile) throw new Error("Telegram client 不支持发送文件");
    const caption = asString(args.caption).trim() || `文件：${import_path.basename(target)}`;
    await getPlatform().sendFile(client, context.msg, target, caption);
    return {
      ok: true,
      title: "文件已发送",
      content: `file: ${relativeDisplay(context, target)}
size: ${stat.size} bytes`
    };
  }
  throw new Error(`\u672A\u77E5\u5DE5\u5177\uFF1A${name}`);
}
function createToolRuntime(runtime: RuntimeContext) {
  return {
    definitions: runtime.answerOnly ? [] : TOOL_DEFINITIONS,
    maxCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
    execute: async (name: string, args: Record<string, any>) => {
      await runtime.onToolStart(name, args);
      let result;
      try {
        result = await executeTool(runtime, name, args);
      } catch (error) {
        result = {
          ok: false,
          title: "工具执行失败",
          content: error instanceof Error ? error.message : String(error)
        };
      }
      await runtime.onToolFinish(name, args, result);
      return result;
    }
  };
}

export { createToolRuntime, workspaceDir };
