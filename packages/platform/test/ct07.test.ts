// CONTRACT-v1 CT-07 / A-01 §4.1: Fastify's ajv never coerces and never strips; bad input is a 400 envelope.
import { Type } from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type FastifyInstance } from '../src/fastify/index.ts';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({
    allowedPeers: ['127.0.0.1/32'],
    routes: (a) => {
      a.post(
        '/echo',
        {
          schema: {
            body: Type.Object({ n: Type.Integer(), s: Type.String() }, { additionalProperties: false }),
          },
        },
        async (req) => ({ got: req.body }),
      );
    },
  });
});
afterAll(async () => {
  await app.close();
});

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/echo', payload: payload as object });

function expectEnvelope(body: string): void {
  const parsed = JSON.parse(body) as { error: Record<string, unknown> };
  expect(Object.keys(parsed)).toEqual(['error']);
  expect(parsed.error.code).toBe('VALIDATION_FAILED');
  expect(typeof parsed.error.message).toBe('string');
  expect(parsed.error.traceId).toMatch(/^[0-9a-f]{32}$/);
}

describe('CT-07 ajv strictness', () => {
  it('premise: a valid request succeeds', async () => {
    const res = await post({ n: 1, s: 'x' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ got: { n: 1, s: 'x' } });
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('extra field -> 400 (not silently stripped)', async () => {
    const res = await post({ n: 1, s: 'x', userId: 'u1' });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body);
  });

  it('string "1" for an integer -> 400 (no coercion)', async () => {
    const res = await post({ n: '1', s: 'x' });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body);
  });

  it('2.5 for an integer -> 400', async () => {
    const res = await post({ n: 2.5, s: 'x' });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body);
  });

  it('number for a string -> 400 (no coercion)', async () => {
    const res = await post({ n: 1, s: 5 });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body);
  });
});
