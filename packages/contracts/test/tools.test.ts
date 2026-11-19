import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import {
  AGENT_ERROR_CODES,
  ALL_TOOLS,
  ExecuteRequestSchema,
  ExecuteResponseSchema,
  ForgetPreferenceParams,
  ListMyTicketsParams,
  OfferBookingParams,
  QuoteRouteParams,
  ResolveCityParams,
  SavePreferenceParams,
  SYS_CALL_PREFIX,
  quoteOfferedIdempotencyKey,
  toolResultMessageKey,
} from '../src/tools/index.ts';

const check = (schema: Parameters<typeof Value.Check>[0], v: unknown) => Value.Check(schema, v);

const cases: Record<string, { schema: Parameters<typeof Value.Check>[0]; ok: unknown[]; bad: unknown[] }> = {
  resolve_city: {
    schema: ResolveCityParams,
    ok: [
      { original: '圣保罗', candidates: ['Sao Paulo'] },
      { original: 'x', candidates: ['a', 'b', 'c'] },
    ],
    bad: [
      { original: 'x', candidates: ['a'], extra: 1 }, // extra field
      { original: 'x', candidates: ['a', 'b', 'c', 'd'] }, // 4 candidates
      { original: 'x', candidates: [] }, // 0 candidates
      { original: 'x', candidates: [1] }, // number in candidates
      { original: 'x', candidates: ['a'.repeat(81)] }, // too long
      { original: '', candidates: ['a'] },
      { candidates: ['a'] }, // missing original
      { original: 'x', candidates: 'a' }, // wrong type
    ],
  },
  quote_route: {
    schema: QuoteRouteParams,
    ok: [{ from: 'Shanghai', to: 'São Paulo' }],
    bad: [{ from: 'A', to: 'B', extra: true }, { from: 'A', to: 2 }, { from: 'A' }, { from: '', to: 'B' }],
  },
  offer_booking: {
    schema: OfferBookingParams,
    ok: [{ quoteId: 'q_01J0000000000000000000000' }],
    bad: [{ quoteId: 'q_1', extra: 1 }, { quoteId: 1 }, {}, { quoteId: '' }],
  },
  list_my_tickets: {
    schema: ListMyTicketsParams,
    ok: [{}, { city: 'Dubai' }, { limit: 50 }, { city: 'Dubai', limit: 1 }],
    bad: [{ extra: 1 }, { limit: 2.5 }, { limit: '1' }, { limit: 0 }, { limit: 51 }, { city: 5 }],
  },
  save_preference: {
    schema: SavePreferenceParams,
    ok: [
      { key: 'home_city', value: 'Shanghai' },
      { key: 'preferred_language', value: 'zh' },
    ],
    bad: [
      { key: 'home_city', value: 'Shanghai', extra: 1 },
      { key: 'preferred_language', value: 'fr' },
      { key: 'avoid_transfer_city', value: 'Dubai' },
      { key: 'home_city', value: 5 },
      { key: 'home_city', value: '' },
      { key: 'home_city' },
    ],
  },
  forget_preference: {
    schema: ForgetPreferenceParams,
    ok: [{ key: 'home_city' }, { key: 'preferred_language' }],
    bad: [{ key: 'home_city', extra: 1 }, { key: 'other' }, { key: 1 }, {}],
  },
};

describe('tool parameter schemas', () => {
  it('covers every tool in ALL_TOOLS exactly once', () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(cases).sort());
    for (const t of ALL_TOOLS) expect(t.parameters).toBe(cases[t.name]!.schema);
  });

  for (const [name, c] of Object.entries(cases)) {
    describe(name, () => {
      it('accepts valid samples', () => {
        for (const v of c.ok) expect(check(c.schema, v), JSON.stringify(v)).toBe(true);
      });
      it('rejects invalid samples (extra field, wrong type, out of range)', () => {
        for (const v of c.bad) expect(check(c.schema, v), JSON.stringify(v)).toBe(false);
      });
    });
  }
});

describe('CT-08 data part: raw params are rejected, never coerced', () => {
  it('rejects number in candidates, extra fields and non-integer / string integers', () => {
    expect(check(ResolveCityParams, { original: 'x', candidates: [1] })).toBe(false);
    expect(check(ResolveCityParams, { original: 'x', candidates: ['a'], user: 'u' })).toBe(false);
    expect(check(ListMyTicketsParams, { limit: 2.5 })).toBe(false);
    expect(check(ListMyTicketsParams, { limit: '1' })).toBe(false);
    expect(check(ExecuteRequestSchema, { name: 'a', input: {}, toolCallId: 'c', runId: 'r', inputSeq: 2.5 })).toBe(
      false,
    );
    expect(check(ExecuteRequestSchema, { name: 'a', input: {}, toolCallId: 'c', runId: 'r', inputSeq: '1' })).toBe(
      false,
    );
  });
});

function* walk(node: unknown, path: string[] = []): Generator<{ path: string[]; key: string; value: unknown }> {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* walk(v, [...path, String(i)]);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield { path, key: k, value: v };
      yield* walk(v, [...path, k]);
    }
  }
}

describe('CT-01: no identity fields in tool schemas', () => {
  const BANNED = ['userid', 'user', 'username', 'sessionid', 'user_id', 'session_id'];
  it('no property key or required entry is an identity field', () => {
    for (const t of ALL_TOOLS) {
      for (const { path, key, value } of walk(t.parameters)) {
        expect(BANNED, `${t.name}: key ${[...path, key].join('.')}`).not.toContain(key.toLowerCase());
        if (key === 'required' && Array.isArray(value)) {
          for (const r of value)
            expect(BANNED, `${t.name}: required ${String(r)}`).not.toContain(String(r).toLowerCase());
        }
      }
    }
  });
  it('the scanner itself catches a planted userId', () => {
    const planted = { type: 'object', properties: { userId: { type: 'string' } } };
    const keys = [...walk(planted)].map((e) => e.key.toLowerCase());
    expect(keys.some((k) => BANNED.includes(k))).toBe(true);
  });
});

describe('CT-02: no order-placing tools', () => {
  const BANNED = /book|confirm|purchase|ticket\.create|issue/i;
  // Whitelist (human-reviewed): offer_booking only SHOWS a card; the user clicks the button on the card
  // and booking-service does the actual write (H-02). "book" is the product term, so it may appear in
  // this one tool's name and descriptions. confirm/purchase/ticket.create/issue stay forbidden there too.
  const WHITELIST: Record<string, RegExp> = { offer_booking: /book/i };

  function strip(tool: string, text: string): string {
    const w = WHITELIST[tool];
    return w ? text.replace(new RegExp(w.source, 'gi'), '') : text;
  }

  it('names, descriptions and parameter descriptions are clean', () => {
    for (const t of ALL_TOOLS) {
      expect(strip(t.name, t.name), t.name).not.toMatch(BANNED);
      expect(strip(t.name, t.description), `${t.name} description`).not.toMatch(BANNED);
      for (const { path, key, value } of walk(t.parameters)) {
        if (key === 'description' && typeof value === 'string') {
          expect(strip(t.name, value), `${t.name} ${path.join('.')}`).not.toMatch(BANNED);
        }
      }
    }
  });
  it('whitelist is exactly offer_booking and no tool name is sys.*', () => {
    expect(Object.keys(WHITELIST)).toEqual(['offer_booking']);
    for (const t of ALL_TOOLS) expect(t.name.startsWith(SYS_CALL_PREFIX)).toBe(false);
  });
});

describe('schema hygiene', () => {
  it('no schema uses Never (`not: {}`) anywhere, including data and envelope', () => {
    const all: unknown[] = [
      ...ALL_TOOLS.flatMap((t) => [t.parameters, t.data]),
      ExecuteRequestSchema,
      ExecuteResponseSchema,
    ];
    for (const s of all) {
      for (const { key, value } of walk(s)) {
        if (key === 'not') {
          expect(value, 'not: {} found').not.toEqual({});
        }
      }
    }
  });

  it('every object schema in parameters has additionalProperties:false', () => {
    for (const t of ALL_TOOLS) {
      const visit = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (n && typeof n === 'object') {
          const o = n as Record<string, unknown>;
          if (o['type'] === 'object') expect(o['additionalProperties'], t.name).toBe(false);
          Object.values(o).forEach(visit);
        }
      };
      visit(t.parameters);
    }
  });

  it('executionMode: side-effecting tools are sequential (D-44), the rest parallel', () => {
    const mode = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t.executionMode]));
    expect(mode).toEqual({
      resolve_city: 'parallel',
      quote_route: 'parallel',
      offer_booking: 'sequential',
      list_my_tickets: 'parallel',
      save_preference: 'sequential',
      forget_preference: 'sequential',
    });
  });
});

describe('execute envelope', () => {
  const req = {
    name: 'quote_route',
    input: { from: 'A', to: 'B' },
    toolCallId: 'call_1',
    runId: 'run_1',
    inputSeq: 42,
  };
  it('request: accepts valid, rejects extra field / inputSeq 0', () => {
    expect(check(ExecuteRequestSchema, req)).toBe(true);
    expect(check(ExecuteRequestSchema, { ...req, userId: 'u' })).toBe(false);
    expect(check(ExecuteRequestSchema, { ...req, inputSeq: 0 })).toBe(false);
  });
  it('response: ok and error shapes; unknown code rejected', () => {
    expect(check(ExecuteResponseSchema, { ok: true, llmText: 't', data: {} })).toBe(true);
    expect(check(ExecuteResponseSchema, { ok: false, error: { code: 'NO_ROUTE', llmText: 't' } })).toBe(true);
    expect(check(ExecuteResponseSchema, { ok: false, error: { code: 'NOPE', llmText: 't' } })).toBe(false);
    expect(check(ExecuteResponseSchema, { ok: true, llmText: 't', data: {}, extra: 1 })).toBe(false);
  });
  it('error codes match A-02 §5.3 and have no duplicates', () => {
    expect(new Set(AGENT_ERROR_CODES).size).toBe(AGENT_ERROR_CODES.length);
    expect(AGENT_ERROR_CODES).toHaveLength(19);
  });
  it('idempotency key builders follow M-6', () => {
    expect(quoteOfferedIdempotencyKey('run_1', 'call_1')).toBe('offer:run_1:call_1');
    expect(toolResultMessageKey('run_1', 'call_1')).toBe('msg:tr:run_1:call_1');
  });
});
