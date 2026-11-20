// execute(name, input) core (A-02 §5.1, A-01 §5.5). Idempotency key (session_id, run_id, tool_call_id) (M-6):
//   1. look the key up: same sha256(canonicalJson(input)) and name -> return the stored response; else IDEMPOTENCY_CONFLICT;
//   2. otherwise run the tool's side effects and INSERT tool_calls as the LAST statement of ONE transaction;
//   3. a primary-key conflict at that insert means a concurrent duplicate committed first: roll back, go to 1.
// So concurrent / retried calls with one key produce exactly one side effect (M-23 ③ retries rely on this).
// Business errors (incl. INVALID_INPUT, UNKNOWN_TOOL) are cached like successes; IDEMPOTENCY_CONFLICT is not.
// sys.* calls are read-only and never cached.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@fb/contracts/server';
import { SYS_CALL_PREFIX, SYS_PROFILE_SNAPSHOT, checkToolArgs, type ExecuteResponse } from '@fb/contracts/tools';
import type { Pool } from '@fb/platform/pg';
import {
  getToolCall,
  inTransaction,
  insertToolCall,
  isToolCallKeyConflict,
  listMemories,
  listMemoryDeletions,
  listTicketRows,
} from './db.ts';
import type { HandsDeps } from './ports.ts';
import { listMyTickets } from './tools/list-my-tickets.ts';
import { offerBooking } from './tools/offer-booking.ts';
import { quoteRoute } from './tools/quote-route.ts';
import { resolveCity } from './tools/resolve-city.ts';
import { forgetPreference, savePreference } from './tools/preferences.ts';
import { fail, ok, type ToolHandler } from './tools/types.ts';

export const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  resolve_city: resolveCity,
  quote_route: quoteRoute,
  offer_booking: offerBooking,
  list_my_tickets: listMyTickets,
  save_preference: savePreference,
  forget_preference: forgetPreference,
};

export interface CallIdentity {
  readonly sessionId: string;
  readonly userId: string;
}

export interface ExecuteCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly toolCallId: string;
  readonly runId: string;
  readonly inputSeq: number;
}

export const inputSha256 = (input: unknown): string =>
  createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');

const CONFLICT_TEXT = 'This toolCallId was already used with different arguments. Do not reuse tool call ids.';
const MAX_KEY_ATTEMPTS = 3;

export interface Engine {
  execute(who: CallIdentity, call: ExecuteCall): Promise<ExecuteResponse>;
}

export function createEngine(pool: Pool, deps: HandsDeps, clock: () => Date = () => new Date()): Engine {
  async function runSys(who: CallIdentity, call: ExecuteCall): Promise<ExecuteResponse> {
    if (call.name !== SYS_PROFILE_SNAPSHOT) return fail('UNKNOWN_TOOL', `Unknown system call: ${call.name}.`);
    if (Object.keys(call.input).length > 0) return fail('INVALID_INPUT', `${call.name} takes no arguments.`);
    const [memories, deletions, tickets] = await Promise.all([
      listMemories(pool, who.userId),
      listMemoryDeletions(pool, who.userId),
      listTicketRows(pool, who.userId),
    ]);
    const snapshot = deps.buildProfile({
      userId: who.userId,
      memories,
      deletions,
      tickets,
      isCityServed: (c) => deps.flightCore.isServed(c),
    });
    return ok('Profile snapshot.', { ...snapshot });
  }

  async function runTool(who: CallIdentity, call: ExecuteCall, hash: string): Promise<ExecuteResponse> {
    return inTransaction(pool, async (client) => {
      const handler = Object.hasOwn(TOOL_HANDLERS, call.name) ? TOOL_HANDLERS[call.name] : undefined;
      let response: ExecuteResponse;
      if (handler === undefined) {
        response = fail('UNKNOWN_TOOL', `Unknown tool: ${call.name}.`);
      } else {
        const check = checkToolArgs(call.name, call.input);
        response = check.ok
          ? await handler(
              {
                sessionId: who.sessionId,
                userId: who.userId,
                runId: call.runId,
                toolCallId: call.toolCallId,
                inputSeq: call.inputSeq,
                now: clock(),
                db: client,
                deps,
              },
              call.input,
            )
          : fail(
              'INVALID_INPUT',
              `Invalid arguments for ${call.name}: ${check.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}.`,
              { errors: check.errors.map((e) => ({ ...e })) },
            );
      }
      await insertToolCall(
        client,
        {
          sessionId: who.sessionId,
          runId: call.runId,
          toolCallId: call.toolCallId,
          name: call.name,
          inputSha256: hash,
        },
        response,
      );
      return response;
    });
  }

  return {
    async execute(who, call) {
      if (call.name.startsWith(SYS_CALL_PREFIX)) return runSys(who, call);
      const hash = inputSha256(call.input);
      for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
        const prior = await getToolCall(pool, who.sessionId, call.runId, call.toolCallId);
        if (prior) {
          return prior.inputSha256 === hash && prior.name === call.name
            ? prior.response
            : fail('IDEMPOTENCY_CONFLICT', CONFLICT_TEXT);
        }
        try {
          return await runTool(who, call, hash);
        } catch (err) {
          if (!isToolCallKeyConflict(err)) throw err;
          // a concurrent duplicate committed first; its response is now visible -> step 1 again
        }
      }
      throw new Error('tool_calls key conflict did not resolve');
    },
  };
}
