// End-to-end runs of the harness against the stand-ins (real pi pipeline, fake DeepSeek over HTTP).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ev } from '../src/events.ts';
import { project } from '../src/projector.ts';
import { computeWork } from '../src/work.ts';
import type { ChatRequest } from './fakes/llm-server.ts';
import { createWorld, onJob, type World } from './fakes/world.ts';

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.stop();
});

const types = (evs: Ev[]): string[] => evs.map((e) => e.type);
const lastToolText = (b: ChatRequest): string => {
  const m = [...b.messages].reverse().find((x) => x.role === 'tool');
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
};
const quoteIdFrom = (b: ChatRequest): string => /q_[0-9A-Z]{26}/.exec(lastToolText(b))?.[0] ?? 'q_missing';

/** resolve ×2 → quote → offer → final reply. */
function bookingScript(
  final = '已为您生成报价，路线和价格请以报价卡为准，点击卡片上的按钮即可下单。',
): (b: ChatRequest, i: number) => object {
  return (b, i) => {
    switch (i) {
      case 0:
        return {
          thinking: 'Need to resolve both cities.',
          text: '我先查一下城市。',
          toolCalls: [
            { name: 'resolve_city', args: { original: '上海', candidates: ['Shanghai'] } },
            { name: 'resolve_city', args: { original: '圣保罗', candidates: ['Sao Paulo', 'São Paulo'] } },
          ],
        };
      case 1:
        return { toolCalls: [{ name: 'quote_route', args: { from: 'Shanghai', to: 'São Paulo' } }] };
      case 2:
        return { toolCalls: [{ name: 'offer_booking', args: { quoteId: quoteIdFrom(b) } }] };
      default:
        return { text: final };
    }
  };
}

describe('happy path', () => {
  it('runs a full booking turn and persists everything in order', async () => {
    const sid = w.session.createSession('zh');
    w.session.addUserMessage(sid, '从上海飞圣保罗');
    w.llm.script = bookingScript() as never;
    const out = await onJob(w.deps('wA'), sid);
    expect(out).toBe('idle');
    const evs = w.session.events(sid);
    expect(types(evs)).toEqual([
      'user.message',
      'agent.run_started',
      'agent.message', // assistant toolUse
      'agent.message', // tr 1
      'agent.message', // tr 2
      'agent.message', // assistant quote_route
      'agent.message', // tr
      'agent.message', // assistant offer
      'agent.message', // tr
      'quote.offered',
      'agent.message', // final
      'agent.run_completed',
    ]);
    expect(computeWork(evs).kind).toBe('none');
    const final = evs[10] as Ev & { payload: { viewText: string; hasToolCalls: boolean } };
    expect(final.payload.hasToolCalls).toBe(false);
    expect(final.payload.viewText).toContain('报价卡');
    const first = evs[2] as Ev & { payload: { viewText: string; processText: string; hasToolCalls: boolean } };
    expect(first.payload).toMatchObject({ hasToolCalls: true, viewText: '', processText: '我先查一下城市。' });
    // max_tokens 4096 reached the wire (V4), thinking low (D-41), no strict (D-48)
    const body = w.llm.requests[0]?.body as ChatRequest;
    expect(body.max_tokens).toBe(4096);
    expect(body.reasoning_effort).toBe('low');
    expect(JSON.stringify(body.tools)).not.toContain('"strict":true');
    // ephemeral events were published with the fence
    const eph = w.redis.published.map((p) => JSON.parse(p.message) as { event: { type: string; fence: number } });
    expect(eph.some((e) => e.event.type === 'agent.delta')).toBe(true);
    expect(eph.some((e) => e.event.type === 'agent.reasoning_delta')).toBe(true);
    expect(eph.filter((e) => e.event.type === 'agent.tool_status').length).toBe(8);
    expect(eph.every((e) => e.event.fence === 1)).toBe(true);
    // projection of the final log is valid and ends with the final reply
    expect(project(evs).at(-1)?.role).toBe('assistant');
  });
});
