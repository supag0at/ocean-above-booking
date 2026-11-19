// The only place outside the adapter that names pi types (A-02 §6.1: @earendil-works/* is confined to src/llm/).
// Everything else in the harness imports these aliases from here.
export type {
  AssistantMessage,
  Message as PiMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  Usage,
} from '@earendil-works/pi-ai';
export type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Exact pi version stored in run_started.piVersion and agent.message.piVersion (S-01 Q1, §6.2). */
export const PI_VERSION = '1.5.2';
