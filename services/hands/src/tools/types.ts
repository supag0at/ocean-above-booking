// Shared tool-adapter types. An adapter receives arguments ALREADY validated by checkToolArgs (engine.ts)
// and the identity from the token; it never sees identity in its input (H-04).
import type { ExecuteErrorResponse, ExecuteOkResponse, ExecuteResponse } from '@fb/contracts/tools';
import type { AgentErrorCode } from '@fb/contracts/tools';
import type { Queryable } from '../db.ts';
import type { HandsDeps } from '../ports.ts';

export interface ToolContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly inputSeq: number;
  readonly now: Date;
  /** Client of the tool transaction; side effects and the tool_calls row commit together. */
  readonly db: Queryable;
  readonly deps: HandsDeps;
}

export type ToolHandler = (ctx: ToolContext, input: unknown) => Promise<ExecuteResponse>;

export const ok = (llmText: string, data: Record<string, unknown>): ExecuteOkResponse => ({ ok: true, llmText, data });

// The contract's ExecuteErrorResponse.error.code statically resolves to `never` (its union is built with
// `.map`, which loses the literal types); the cast restores the intended AgentErrorCode. Reported to the parent.
export const fail = (code: AgentErrorCode, llmText: string, data?: Record<string, unknown>): ExecuteErrorResponse =>
  ({
    ok: false,
    error: data === undefined ? { code, llmText } : { code, llmText, data },
  }) as unknown as ExecuteErrorResponse;
