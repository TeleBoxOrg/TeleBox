// agentCore.ts — barrel file: re-exports from the 6 split modules
// 业务逻辑已拆分到 agentTypes / agentProvider / agentTools / agentStore / agentLoop / agentPlugin
// 此文件仅保留公开 API 的 re-export，保证 agent.ts 的 import 路径不变。

export { initAgentPlatform, getPlatform } from "./agentTypes";
export type {
  AgentPlatform,
  ProviderType,
  AuthMethod,
  AgentScope,
  ChatRole,
  AIProvider,
  ChatImage,
  ChatMessage,
  ToolCall,
  ToolSpec,
  Usage,
  ModelResponse,
  ConversationRecord,
  WorkspaceEntry,
  WorkspaceRef,
  CommandResult,
  ToolResult,
  AgentOptions,
  RuntimeToolDef,
  AgentRuntime,
  AgentInput,
  RunAgentResult,
  AgentConfig,
  RuntimeContext,
} from "./agentTypes";

export { AgentPlugin } from "./agentPlugin";
