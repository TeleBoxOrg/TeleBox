// ─────────────────────────── 平台抽象层 ───────────────────────────
export interface AgentPlatform {
  safeEdit(msg: any, text: string, options: AgentOptions): Promise<any>;
  safeReply(msg: any, text: string, options: AgentOptions): Promise<any>;
  buildReplyContext(msg: any, workspace: any): Promise<{ text: string; images: ChatImage[]; savedFiles: string[] }>;
  sendFile(client: any, msg: any, filePath: string, caption: string): Promise<void>;
}
let __platform: AgentPlatform | null = null;
export function initAgentPlatform(platform: AgentPlatform) { __platform = platform; }
export function getPlatform(): AgentPlatform {
  if (!__platform) throw new Error("AgentPlatform not initialized — call initAgentPlatform() first");
  return __platform;
}


// ─────────────────────────── 真实类型层 ───────────────────────────
export type ProviderType = "openai" | "gemini" | "anthropic" | "responses" | "deepseek" | "xai" | "custom";
export type AuthMethod = "bearer" | "api_key_header" | "query_param";
export type AgentScope = "private" | "group" | "system" | "global" | "telebox";
export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface AIProvider {
  name: string;
  type?: ProviderType;
  api_interface?: ProviderType;
  model: string;
  base_url: string;
  api_key: string;
  auth_method?: AuthMethod;
  [key: string]: unknown;
}
export interface ChatImage { mimeType: string; base64: string; }
export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  images?: ChatImage[];
  at?: string;
  media?: any;
}
export interface ToolCall {
  id: string; name: string; arguments: Record<string, unknown>;
  function?: { name?: string; arguments?: string | unknown };
}
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown>; }
export interface Usage { prompt?: number; completion?: number; total?: number; }
export interface ModelResponse { text: string; toolCalls: ToolCall[]; usage?: Usage; }
export interface ConversationRecord { id: string; updatedAt: string; messages: ChatMessage[]; }
export interface WorkspaceEntry { path: string; name: string; type: "file" | "directory"; size?: number; }
export interface WorkspaceRef { dir: string; path?: string; name?: string; id?: string; }
export interface CommandResult {
  stdout: string; stderr: string; exitCode: number;
  timedOut?: boolean; killed?: boolean; durationMs?: number; truncated?: boolean; code?: number;
}
export interface ToolResult { ok: boolean; title: string; content: string; replace?: boolean; }
export interface AgentOptions {
  html?: boolean; plainFallback?: string; parseMode?: string; linkPreview?: boolean;
  scope?: AgentScope;
  [key: string]: unknown;
}
export interface RuntimeToolDef { name: string; description: string; parameters: Record<string, unknown>; }
export interface AgentRuntime {
  provider: AIProvider; maxSteps: number; timeoutMs: number;
  answerOnly?: boolean; planFirst?: boolean; projectRoot?: string; workspace?: string; scope?: AgentScope;
}
export interface AgentInput {
  msg?: any;
  runtime?: RuntimeContext;
  provider?: AIProvider;
  config?: AgentConfig;
  workspace?: WorkspaceRef;
  displayName?: string;
  icon?: string;
  maxSteps?: number;
  request?: string;
  scope?: AgentScope;
  projectRoot?: string;
  answerOnly?: boolean;
  planFirst?: boolean;
  history?: ChatMessage[];
  userMessage?: ChatMessage;
  onStep?: (step: number) => void | Promise<void>;
  onUsage?: (usage: Usage | undefined) => void | Promise<void>;
  onPlanChange?: (plan: { explanation?: string; items: { step: string; status: string }[] }) => void | Promise<void>;
  onToolStart?: (name: string, args: Record<string, unknown>) => void | Promise<void>;
  onToolFinish?: (name: string, args: Record<string, unknown>, result: ToolResult) => void | Promise<void>;
  dispatchPlugin?: (command: string, msg: any) => void | Promise<void>;
  [key: string]: unknown;
}
export interface RunAgentResult { answer: string; usage?: Usage; }
export interface AgentConfig {
  agent_schema_version?: number; agent_migrated_at?: string; zn_name?: string;
  providers?: Record<string, AIProvider>; default_provider?: string | null;
  prompts?: Record<string, string>; skill_raws?: Record<string, string>;
  zn_conversations?: Record<string, ConversationRecord>; zn_workspaces?: Record<string, unknown>;
  system_timeout?: number; max_agent_steps?: number; conversation_context_limit?: number;
  [key: string]: unknown;
}
export interface RuntimeContext {
  msg: any; workspace?: WorkspaceRef; scope?: AgentScope; signal?: AbortSignal;
  projectRoot?: string; commandTimeoutMs?: number; answerOnly?: boolean;
  provider: AIProvider; maxSteps: number; timeoutMs: number; planFirst?: boolean;
  onStep?: (step: number) => void | Promise<void>;
  onUsage?: (usage: Usage | undefined) => void | Promise<void>;
  onPlanChange: (plan: { explanation?: string; items: { step: string; status: string }[] }) => void | Promise<void>;
  onToolStart: (name: string, args: Record<string, unknown>) => void | Promise<void>;
  onToolFinish: (name: string, args: Record<string, unknown>, result: ToolResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  dispatchPlugin: (command: string, msg: any) => void | Promise<void>;
  [key: string]: unknown;
}
