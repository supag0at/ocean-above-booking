// §6.5 first-batch verification against the REAL DeepSeek API (T09). Hard budget: 40 requests in this script
// (task total ≤ 50). The key is read only from the main checkout's .env and never printed; every printed string is
// scrubbed for it.
//   node services/harness/scripts/live-check.ts
import { ALL_TOOLS } from '@fb/contracts/tools';
import { compact } from '../src/compactor.ts';
import type { Ev } from '../src/events.ts';
import { createLlm, runAgent } from '../src/llm/runtime.ts';
import { project } from '../src/projector.ts';
import { SYSTEM_PROMPT } from '../src/prompt.ts';
import { FakeLlmServer, type ChatRequest } from '../test/fakes/llm-server.ts';
import { createWorld, onJob } from '../test/fakes/world.ts';
import { loadDeepseekKey } from './demo.ts';

const BUDGET = 40;
let calls = 0;
const key = loadDeepseekKey();
const scrub = (s: string): string =>
  s
    .split(key)
    .join('[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[REDACTED]');
const out = (label: string, v: unknown): void =>
  console.log(scrub(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`));
const count = (): void => {
  calls++;
  if (calls > BUDGET) throw new Error(`live budget ${BUDGET} exceeded`);
};

const llm = createLlm({ apiKey: () => key });

async function rawPost(body: unknown, apiKey = key): Promise<{ status: number; text: string }> {
  count();
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: (await r.text()).slice(0, 300) };
}

const ONLY_V18 = process.argv.includes('--only-v18');

/** V18 alone: two runs via the scripted fake LLM (0 live calls), then ONE live run that starts with a compaction. */
async function v18(): Promise<void> {
  const w = await createWorld();
  try {
    w.llm.script = (b, i) =>
      [
        {
          thinking: '解析城市',
          toolCalls: [{ name: 'resolve_city', args: { original: '上海', candidates: ['Shanghai'] } }],
        },
        { thinking: '回答', text: '已找到 Shanghai。' },
        { thinking: '报价', toolCalls: [{ name: 'quote_route', args: { from: 'Shanghai', to: 'Tokyo' } }] },
        { thinking: '回答', text: '报价已生成，请看报价卡。' },
      ][i] ?? { text: 'x' };
    const sid = w.session.createSession('zh');
    for (const t of ['上海在不在网络里', '上海到东京']) {
      w.session.addUserMessage(sid, t);
      await onJob(w.deps('fake'), sid);
    }
    w.session.addUserMessage(sid, '刚才那张报价还在吗？');
    const sent: ChatRequest[] = [];
    out(
      'V18 job',
      await onJob(
        w.deps('live', {
          llm,
          now: () => new Date(),
          compactOptions: { high: 10, low: 10 },
          onLlmPayload: (p) => {
            count();
            sent.push(JSON.parse(JSON.stringify(p)) as ChatRequest);
          },
        }),
        sid,
      ),
    );
    const evs = w.session.events(sid);
    const cmp = evs.find((e) => e.type === 'agent.context_compacted');
    out('V18 compaction written', cmp === undefined ? 'no' : (cmp.payload as { summaryText: string }).summaryText);
    out(
      'V18 folded run absent from the live request',
      sent.map((p) => !JSON.stringify(p.messages).includes('上海在不在网络里')),
    );
    out(
      'V18 kept run still has its reasoning_content',
      sent.map((p) =>
        p.messages.filter((m) => m.role === 'assistant').map((m) => (m.reasoning_content ?? '').length > 0),
      ),
    );
    out(
      'V18 statuses (all requests accepted?)',
      evs.filter((e) => e.type === 'agent.run_completed' || e.type === 'agent.run_failed').map((e) => e.type),
    );
    out(
      'V18 final reply',
      (evs.filter((e) => e.type === 'agent.message').at(-1)?.payload as { viewText?: string }).viewText,
    );
  } finally {
    out('live DeepSeek requests used by this script', calls);
    await w.stop();
  }
}

async function main(): Promise<void> {
  if (ONLY_V18) return v18();
  const w = await createWorld();
  const replay = new FakeLlmServer();
  await replay.start();
  replay.script = () => ({ text: 'x' });
  const payloads: ChatRequest[] = [];
  const deltaKinds = new Set<string>();
  try {
    // ---------------------------------------------------------------- live conversation (V2,V3,V4,V5,V6+,V9,V10,V16)
    const deps = w.deps('live', {
      llm,
      now: () => new Date(),
      onLlmPayload: (p) => {
        count();
        payloads.push(JSON.parse(JSON.stringify(p)) as ChatRequest);
      },
    });
    const sid = w.session.createSession('zh');
    for (const text of ['从上海飞圣保罗，帮我订票', '再帮我看看上海到东京']) {
      w.session.addUserMessage(sid, text);
      out(`job "${text}"`, await onJob(deps, sid));
    }
    const evs = w.session.events(sid);
    for (const p of w.redis.published) {
      const e = JSON.parse(p.message) as { event: { type: string } };
      deltaKinds.add(e.event.type);
    }
    out(
      'events',
      evs.map((e) => e.type + (e.type === 'agent.message' ? `/${(e.payload as { role: string }).role}` : '')).join(' '),
    );
    out('requests', payloads.length);
    out(
      'V4 max_tokens on the wire',
      payloads.map((p) => p.max_tokens),
    );
    out(
      'V4 reasoning_effort / thinking',
      payloads.map((p) => [p.reasoning_effort, p.thinking]),
    );
    out(
      'V5 first request roles',
      payloads[0]?.messages.map((m) => m.role),
    );
    out(
      'V3 system messages persisted',
      evs.filter((e) => e.type === 'agent.message' && (e.payload as { role: string }).role === 'system').length,
    );
    out(
      'V3 system role on the wire (first msg)',
      payloads.map((p) => p.messages[0]?.role),
    );
    out('V9 ephemeral kinds', [...deltaKinds]);
    const assistantsWithThinking = evs.filter(
      (e) =>
        e.type === 'agent.message' && (e.payload as { messageJson: string }).messageJson.includes('"type":"thinking"'),
    ).length;
    out('V9 persisted assistant messages with thinking blocks', assistantsWithThinking);
    const last = payloads.at(-1);
    out(
      'V6 replayed assistants carrying reasoning_content',
      last?.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0),
    );
    const ids = payloads.flatMap((p) =>
      p.messages.flatMap((m) => ((m.tool_calls as { id: string }[] | undefined) ?? []).map((c) => c.id)),
    );
    out('V16 toolCallIds (unique within the session?)', {
      total: new Set(ids).size,
      unique: new Set(ids).size === ids.length || 'dup across requests is expected',
    });
    const toolBatch = evs.filter(
      (e) => e.type === 'agent.message' && (e.payload as { hasToolCalls?: boolean }).hasToolCalls,
    );
    out(
      'V10 tool calls per assistant',
      toolBatch.map(
        (e) =>
          (
            JSON.parse((e.payload as { messageJson: string }).messageJson) as { content: { type: string }[] }
          ).content.filter((c) => c.type === 'toolCall').length,
      ),
    );

    // ---------------------------------------------------------------- V1 golden on live data (0 live calls)
    let k = 0;
    let same = 0;
    for (const e of evs) {
      if (e.type !== 'agent.message') continue;
      const p = e.payload as { role: string; meta?: unknown };
      if (p.role !== 'assistant' || p.meta !== undefined) continue;
      const prefix = evs.filter((x) => x.seq < e.seq);
      const runStart = [...prefix].reverse().find((x) => x.type === 'agent.run_started') as Ev & {
        payload: { runId: string };
      };
      replay.requests.length = 0;
      await runAgent({
        llm: createLlm({ baseUrl: replay.baseUrl, apiKey: () => 'k' }),
        systemPrompt: SYSTEM_PROMPT,
        tools: ALL_TOOLS,
        messages: project(prefix, runStart.payload.runId),
        sessionId: sid,
        executeTool: async () => ({ text: '', details: {} }),
        admitTool: () => undefined,
        shouldEndTurn: () => true,
        onEvent: async () => undefined,
        signal: new AbortController().signal,
      });
      // guard-rejected candidates are not persisted, so align on the request that produced THIS message:
      const orig = payloads.find(
        (p) => JSON.stringify(p.messages) === JSON.stringify(replay.requests[0]?.body.messages),
      );
      if (orig !== undefined && JSON.stringify(orig.tools) === JSON.stringify(replay.requests[0]?.body.tools)) same++;
      k++;
    }
    out('V1 live golden: rebuilt requests byte-identical (messages+tools)', `${same}/${k}`);

    // ---------------------------------------------------------------- V6 negative: strip old reasoning_content
    if (last !== undefined) {
      const stripped = JSON.parse(JSON.stringify(last)) as ChatRequest;
      for (const m of stripped.messages) if (m.role === 'assistant') delete m.reasoning_content;
      stripped.stream = false;
      delete stripped.stream_options;
      const r = await rawPost(stripped);
      out('V6 history WITHOUT reasoning_content (tools + thinking)', `${r.status} ${r.text}`);
      const kept = JSON.parse(JSON.stringify(last)) as ChatRequest;
      kept.stream = false;
      delete kept.stream_options;
      const r2 = await rawPost(kept);
      out('V6 same history WITH reasoning_content', `${r2.status}`);
    }

    // ---------------------------------------------------------------- V18 compaction: folded runs vanish entirely
    const runs = evs.filter((e) => e.type === 'agent.run_started');
    if (runs.length >= 2) {
      w.session.addUserMessage(sid, '谢谢');
      const evs2 = w.session.events(sid);
      const pending = [evs2.at(-1)?.seq ?? 0];
      const cmp = compact(evs2, pending, { high: 10, low: 10 });
      out(
        'V18 compaction',
        cmp === null
          ? 'null'
          : {
              boundary: cmp.boundaryRunId === (runs[1]?.payload as { runId: string }).runId,
              estBefore: cmp.estBefore,
              estAfter: cmp.estAfter,
            },
      );
      if (cmp !== null) {
        w.session.inject = undefined;
        // write it as the compactor would, then run the next run for real
        const before = payloads.length;
        out(
          'V18 job after compaction',
          await onJob(
            w.deps('live', {
              llm,
              now: () => new Date(),
              onLlmPayload: (p) => {
                count();
                payloads.push(JSON.parse(JSON.stringify(p)) as ChatRequest);
              },
            }),
            sid,
          ),
        );
        const evs3 = w.session.events(sid);
        out(
          'V18 compacted event written',
          evs3.some((e) => e.type === 'agent.context_compacted'),
        );
        const after = payloads.slice(before);
        out(
          'V18 requests after compaction (folded run absent?)',
          after.map((p) => !JSON.stringify(p.messages).includes('从上海飞圣保罗')),
        );
        out(
          'V18 run outcome',
          evs3
            .filter((e) => e.type === 'agent.run_completed' || e.type === 'agent.run_failed')
            .map((e) => e.type)
            .at(-1),
        );
      }
    }

    // ---------------------------------------------------------------- V13 failure behaviour (bad key)
    {
      const bad = createLlm({ apiKey: () => 'invalid-key-for-t09-v13' });
      let stop: string | undefined;
      let threw: string | undefined;
      try {
        const r = await runAgent({
          llm: bad,
          systemPrompt: SYSTEM_PROMPT,
          tools: ALL_TOOLS,
          messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
          sessionId: 'v13',
          executeTool: async () => ({ text: '', details: {} }),
          admitTool: () => undefined,
          shouldEndTurn: () => true,
          onEvent: async (e) => {
            if (e.type === 'request_start') count();
            if (e.type === 'assistant_end')
              stop = `${e.message.stopReason} / ${scrub(String(e.message.errorMessage)).slice(0, 160)}`;
          },
          signal: new AbortController().signal,
        });
        void r;
      } catch (e) {
        threw = (e as Error).message;
      }
      out('V13 401 → stopReason/errorMessage', stop ?? 'none');
      out('V13 thrown', threw ?? 'no (reported as stopReason)');
    }
  } finally {
    out('live DeepSeek requests used by this script', calls);
    await replay.stop();
    await w.stop();
  }
}

void main().catch((e: unknown) => {
  console.error(scrub((e as Error).stack ?? String(e)));
  process.exitCode = 1;
});
