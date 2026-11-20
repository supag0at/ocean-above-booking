// pi adapter (A-02 §6.1): the ONLY module that constructs pi objects. Rebuilds an Agent from projected messages,
// calls continue() (never prompt / prepareRequest / transformContext), and forwards events to the caller, which
// persists them. The caller's onEvent is awaited by pi, so it acts as a write barrier (S-01 Q8).
import { Agent, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, type Model } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { LLM_PREFIX_BLOCKED, type ToolDefinition } from '@fb/contracts/tools';
import { MAX_TOKENS, MODEL_ID } from '@fb/contracts/flight';
import { rawArgsErrors } from './strict-check.ts';
import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from './types.ts';

export interface LlmOptions {
  /** override for tests (fake OpenAI-compatible server); default https://api.deepseek.com */
  readonly baseUrl?: string;
  /** API key supplier; the key never leaves this callback */
  readonly apiKey: () => string | undefined;
}

export interface Llm {
  readonly model: Model<'openai-completions'>;
  readonly apiKey: () => string | undefined;
  readonly streamFn: (
    ...args: Parameters<ReturnType<typeof createModels>['streamSimple']>
  ) => ReturnType<ReturnType<typeof createModels>['streamSimple']>;
}

export function createLlm(opts: LlmOptions): Llm {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const base = models.getModel('deepseek', MODEL_ID);
  if (base === undefined) throw new Error(`pi catalog has no deepseek/${MODEL_ID}`);
  // D-50: max_tokens 4096 via the model object (verified in the golden test, V4)
  const model = {
    ...(base as Model<'openai-completions'>),
    maxTokens: MAX_TOKENS,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  };
  // only our retry layer (§3.5, V13): pi-ai's provider retry is switched off
  const streamFn: Llm['streamFn'] = (m, ctx, o) => models.streamSimple(m, ctx, { ...o, maxRetries: 0 });
  return { model, apiKey: opts.apiKey, streamFn };
}

export type RuntimeEvent =
  /** the provider request is about to be sent (from onPayload): start of the 60s request timer */
  | { readonly type: 'request_start'; readonly payload: unknown }
  | { readonly type: 'assistant_start' }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | { readonly type: 'assistant_end'; readonly message: AssistantMessage }
  | { readonly type: 'tool_result'; readonly message: ToolResultMessage }
  | { readonly type: 'tool_allowed'; readonly toolCallId: string; readonly name: string }
  | { readonly type: 'tool_end'; readonly toolCallId: string; readonly name: string; readonly isError: boolean };

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  /** what the model actually sent (already strictly validated) */
  readonly rawArgs: Record<string, unknown>;
  /** pi's coerced args (semantically equal to rawArgs once the strict check passed) */
  readonly args: unknown;
}

export interface ToolOutcome {
  /** text for the LLM, with the §5.1 prefix */
  readonly text: string;
  readonly details: unknown;
}

export interface RunOptions {
  readonly llm: Llm;
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly messages: AgentMessage[];
  readonly sessionId: string;
  readonly executeTool: (call: ToolCallRequest, signal: AbortSignal | undefined) => Promise<ToolOutcome>;
  /** extra admission check after the raw-args check (tool budget); a string blocks with that reason */
  readonly admitTool: (call: ToolCall, index: number) => string | undefined;
  /** finishTurn: true ends the pi run after this turn's tool results (turn limit) */
  readonly shouldEndTurn: () => boolean;
  readonly onEvent: (e: RuntimeEvent) => Promise<void>;
  readonly signal: AbortSignal;
}

export interface RunResult {
  /** stopReason of the last assistant message pi produced (persisted or not) */
  readonly lastStopReason: AssistantMessage['stopReason'] | undefined;
}

function toAgentTools(
  defs: readonly ToolDefinition[],
  run: RunOptions,
  rawById: Map<string, Record<string, unknown>>,
): AgentTool[] {
  return defs.map((d): AgentTool => ({
    name: d.name,
    label: d.name,
    description: d.description,
    // TypeBox output is plain JSON Schema; DeepSeek receives it byte-identical (S-01 Q9)
    parameters: d.parameters as unknown as AgentTool['parameters'],
    executionMode: d.executionMode,
    execute: async (toolCallId, params, signal) => {
      const out = await run.executeTool(
        { id: toolCallId, name: d.name, rawArgs: rawById.get(toolCallId) ?? {}, args: params },
        signal,
      );
      return { content: [{ type: 'text', text: out.text }], details: out.details };
    },
  }));
}

export async function runAgent(run: RunOptions): Promise<RunResult> {
  if (run.signal.aborted) return { lastStopReason: 'aborted' };
  const tail = run.messages[run.messages.length - 1];
  if (tail === undefined || (tail.role !== 'user' && tail.role !== 'toolResult')) {
    // S-01 Q4: continue() throws on an assistant tail; the caller must have handled it (§3.6)
    throw new Error(`cannot continue from tail role ${tail?.role ?? 'none'}`);
  }
  const rawById = new Map<string, Record<string, unknown>>();
  const defs = new Map(run.tools.map((t) => [t.name, t]));
  let lastStopReason: AssistantMessage['stopReason'] | undefined;

  const agent = new Agent({
    initialState: {
      systemPrompt: run.systemPrompt,
      model: run.llm.model,
      thinkingLevel: 'low',
      tools: toAgentTools(run.tools, run, rawById),
      messages: run.messages,
    },
    streamFn: run.llm.streamFn,
    getApiKey: () => run.llm.apiKey(),
    toolExecution: 'parallel',
    sessionId: run.sessionId,
    onPayload: async (payload) => {
      await run.onEvent({ type: 'request_start', payload });
      return undefined;
    },
    beforeToolCall: async ({ toolCall, assistantMessage }) => {
      // CT-08: check the RAW arguments first (pi silently coerces 2.5→2, 1→"1", ... S-01 Q9)
      const errors = defs.has(toolCall.name)
        ? rawArgsErrors(toolCall.name, toolCall.arguments)
        : [`unknown tool ${toolCall.name}`];
      if (errors.length > 0) {
        return { block: true, reason: `${LLM_PREFIX_BLOCKED}INVALID_INPUT: ${errors.slice(0, 3).join('; ')}` };
      }
      const index = assistantMessage.content
        .filter((c) => c.type === 'toolCall')
        .findIndex((c) => c.id === toolCall.id);
      const blocked = run.admitTool(toolCall, index);
      if (blocked !== undefined) return { block: true, reason: blocked };
      rawById.set(toolCall.id, toolCall.arguments);
      await run.onEvent({ type: 'tool_allowed', toolCallId: toolCall.id, name: toolCall.name });
      return undefined;
    },
    finishTurn: () => (run.shouldEndTurn() ? { action: 'end' } : undefined),
  });

  agent.subscribe(async (e: AgentEvent) => {
    switch (e.type) {
      case 'message_start':
        if (e.message.role === 'assistant') await run.onEvent({ type: 'assistant_start' });
        return;
      case 'message_update': {
        const ev = e.assistantMessageEvent;
        if (ev.type === 'text_delta') await run.onEvent({ type: 'text_delta', delta: ev.delta });
        else if (ev.type === 'thinking_delta') await run.onEvent({ type: 'thinking_delta', delta: ev.delta });
        return; // toolcall deltas are not pushed
      }
      case 'message_end':
        if (e.message.role === 'assistant') {
          lastStopReason = e.message.stopReason;
          await run.onEvent({ type: 'assistant_end', message: e.message });
        } else if (e.message.role === 'toolResult') {
          await run.onEvent({ type: 'tool_result', message: e.message as ToolResultMessage });
        }
        // system messages: under V3 outcome ② pi never emits them on continue(); see llm/README in the T09 report
        return;
      case 'tool_execution_end':
        await run.onEvent({ type: 'tool_end', toolCallId: e.toolCallId, name: e.toolName, isError: e.isError });
        return;
      default:
        return;
    }
  });

  const onAbort = (): void => agent.abort();
  run.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await agent.continue();
  } finally {
    run.signal.removeEventListener('abort', onAbort);
  }
  return { lastStopReason };
}

/** Build a pi assistant message for a template (A-02 §12.1; snapshot-tested against pi 1.5.2 types). */
export function templateAssistantMessage(llm: Llm, text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: llm.model.api,
    provider: llm.model.provider,
    model: llm.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

/** A harness-built toolResult (fills, §3.6). `details` carries our structured data for audit only. */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
  timestamp: number,
  details: unknown = {},
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    details: details as ToolResultMessage['details'],
    isError,
    timestamp,
  } as ToolResultMessage;
}
