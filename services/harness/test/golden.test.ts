// Golden round trip (A-02 §4.1, §14.1 D-58 hard gate; §6.5 V1/V15): every request the first run actually sent is
// rebuilt from the persisted log (stored with jsonb key order) and re-serialised by pi; `messages` and `tools` must be
// byte-identical.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ev } from '../src/events.ts';
import { runAgent } from '../src/llm/runtime.ts';
import { project } from '../src/projector.ts';
import { SYSTEM_PROMPT } from '../src/prompt.ts';
import { ALL_TOOLS } from '@fb/contracts/tools';
import { createLlm } from '../src/llm/runtime.ts';
import type { ChatRequest } from './fakes/llm-server.ts';
import { FakeLlmServer } from './fakes/llm-server.ts';
import { createWorld, onJob, type World } from './fakes/world.ts';

let w: World;
let replay: FakeLlmServer;
beforeEach(async () => {
  w = await createWorld();
  replay = new FakeLlmServer();
  await replay.start();
  replay.script = () => ({ text: 'x' });
});
afterEach(async () => {
  await w.stop();
  await replay.stop();
});

const qid = (b: ChatRequest): string =>
  /q_[0-9A-Z]{26}/.exec(JSON.stringify(b.messages.at(-1)?.content ?? ''))?.[0] ?? 'q_x';

/** Two runs (second with a mid-run booking), thinking on, parallel tool calls, an error result. */
function script(b: ChatRequest, i: number): object {
  const turns: object[] = [
    {
      thinking: '思考：两个城市都要解析。',
      text: '我先查城市。',
      toolCalls: [
        { name: 'resolve_city', args: { original: '上海', candidates: ['Shanghai'] } },
        { name: 'resolve_city', args: { original: '圣保罗', candidates: ['Sao Paulo'] } },
      ],
    },
    { thinking: 'quote', toolCalls: [{ name: 'quote_route', args: { from: 'Shanghai', to: 'São Paulo' } }] },
    { toolCalls: [{ name: 'offer_booking', args: { quoteId: qid(b) } }] },
    { thinking: 'done', text: '报价已生成，请看报价卡。' },
    // run 2
    {
      thinking: 'tickets',
      toolCalls: [
        { name: 'list_my_tickets', args: { limit: 5 } },
        { name: 'quote_route', args: { from: 'Nowhere', to: 'Tokyo' } },
      ],
    },
    { text: '已确认出票。' },
  ];
  return turns[i] ?? { text: 'end' };
}

/** Events strictly before the assistant message produced by request k (or the whole log for the last one). */
function prefixBeforeRequest(evs: Ev[], k: number): Ev[] {
  let count = 0;
  for (const e of evs) {
    if (e.type === 'agent.message' && e.payload.role === 'assistant' && e.payload.meta === undefined) {
      if (count === k) return evs.filter((x) => x.seq < e.seq);
      count++;
    }
  }
  throw new Error(`no assistant #${k}`);
}

describe('golden round trip (V1)', () => {
  it('rebuilt requests equal the first-run requests byte for byte (messages + tools)', async () => {
    const sid = w.session.createSession('zh');
    w.session.addUserMessage(sid, '从上海飞圣保罗');
    w.llm.script = script as never;
    expect(await onJob(w.deps('wA'), sid)).toBe('idle');
    // a booking lands between runs, then the user asks again
    const offered = w.session.events(sid).find((e) => e.type === 'quote.offered') as Ev & {
      payload: { quoteId: string };
    };
    w.session.addBookingConfirmed(sid, {
      quoteId: offered.payload.quoteId,
      ticketId: 't_01JD3XKQ8M7N2P4R6T8V0W2Y5A',
      ticketNo: 'OA-0W2Y5A00',
      summary: {
        ticketNo: 'OA-0W2Y5A00',
        from: 'Shanghai',
        to: 'São Paulo',
        legs: [
          { from: 'Shanghai', to: 'Hong Kong' },
          { from: 'Hong Kong', to: 'São Paulo' },
        ],
        transferCities: ['Hong Kong'],
        display: { legs: ['1717.86', '1542.07'], totalDistanceKm: '3259.93', priceUsd: '423.79' },
      },
    });
    w.session.addUserMessage(sid, '订好了吗？我还有哪些票');
    expect(await onJob(w.deps('wA'), sid)).toBe('idle');

    const evs = w.session.events(sid);
    // stored payloads really were reordered (jsonb simulation is active)
    const tr = evs.find((e) => e.type === 'agent.message' && e.payload.role === 'toolResult') as Ev;
    expect(Object.keys(tr.payload)[0]).not.toBe('runId');

    const original = w.llm.requests;
    expect(original.length).toBe(6);
    const llm = createLlm({ baseUrl: replay.baseUrl, apiKey: () => 'k' });
    for (let k = 0; k < original.length; k++) {
      const prefix = prefixBeforeRequest(evs, k);
      const runId = [...prefix].reverse().find((e) => e.type === 'agent.run_started') as Ev & {
        payload: { runId: string };
      };
      const messages = project(prefix, runId.payload.runId);
      replay.requests.length = 0;
      await runAgent({
        llm,
        systemPrompt: SYSTEM_PROMPT,
        tools: ALL_TOOLS,
        messages,
        sessionId: sid,
        executeTool: async () => ({ text: '', details: {} }),
        admitTool: () => undefined,
        shouldEndTurn: () => true,
        onEvent: async () => undefined,
        signal: new AbortController().signal,
      });
      const a = original[k]?.body as ChatRequest;
      const b = replay.requests[0]?.body as ChatRequest;
      expect(JSON.stringify(b.messages), `request ${k} messages`).toBe(JSON.stringify(a.messages));
      expect(JSON.stringify(b.tools), `request ${k} tools`).toBe(JSON.stringify(a.tools));
    }
    // V6 shape: every replayed assistant turn carries reasoning_content
    const last = original.at(-1)?.body as ChatRequest;
    const assistants = last.messages.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBeGreaterThan(3);
    expect(assistants.every((m) => typeof m.reasoning_content === 'string')).toBe(true);
    // V15: user timestamps are not sent to the model
    expect(JSON.stringify(last.messages)).not.toMatch(/timestamp/);
    // V12: tool `details` (our structured data) never reaches the model
    expect(JSON.stringify(last.messages)).not.toContain('priceUsd');
    // run 2 sees the booking hung in front of it (D-55)
    expect(JSON.stringify(last.messages)).toContain('booking.confirmed');
    // V16: toolCallIds unique within each run
    const ids = last.messages.flatMap((m) => ((m.tool_calls as { id: string }[] | undefined) ?? []).map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
