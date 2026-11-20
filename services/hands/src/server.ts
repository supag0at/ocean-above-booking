// hands HTTP surface (A-01 §5.5): POST /internal/execute only, on the platform Fastify factory
// (strict ajv, peer check, trace, 16 KB body limit). Envelope errors are HTTP errors (ApiError);
// tool outcomes are always 200 { ok, ... } (A-02 §5.1).
import type { KeyObject } from 'node:crypto';
import { MAX_HANDS_BODY_BYTES } from '@fb/contracts/server';
import { ExecuteRequestSchema, type ExecuteRequest } from '@fb/contracts/tools';
import { buildServer, errorEnvelope, type FastifyInstance, type ServerOptions } from '@fb/platform/fastify';
import type { Logger } from '@fb/platform/log';
import type { Pool } from '@fb/platform/pg';
import { authenticate } from './auth.ts';
import { createEngine } from './engine.ts';
import type { HandsDeps } from './ports.ts';

export const EXECUTE_PATH = '/internal/execute';

export interface HandsServerOptions {
  readonly pool: Pool;
  readonly deps: HandsDeps;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
  readonly allowedPeers: readonly string[];
  readonly logger?: Logger;
  /** seconds clock for token checks; tests pin it */
  readonly nowSec?: () => number;
  readonly now?: () => Date;
}

/** Platform server options for hands; used by buildHandsServer (inject/tests) and createServer (main). */
export function handsServerOptions(o: HandsServerOptions): ServerOptions {
  const engine = createEngine(o.pool, o.deps, o.now);
  const nowSec = o.nowSec ?? (() => Math.floor(Date.now() / 1000));
  return {
    allowedPeers: o.allowedPeers,
    bodyLimit: MAX_HANDS_BODY_BYTES,
    ...(o.logger ? { logger: o.logger } : {}),
    ready: async () => {
      await o.pool.query('SELECT 1');
    },
    routes: (app) => {
      app.post<{ Body: ExecuteRequest }>(EXECUTE_PATH, { schema: { body: ExecuteRequestSchema } }, async (req, reply) => {
        const started = Date.now();
        const traceId = req.trace.traceId;
        const body = req.body;
        const auth = await authenticate(req.headers.authorization, o.publicKeys, o.pool, nowSec());
        if (!auth.ok) {
          req.log.warn({ tool: body.name, reason: auth.reason, traceId }, 'hands auth rejected');
          // HANDS_AUTH is an agent-side code without an HTTP-table entry; 401 makes harness re-acquire the token.
          return reply.code(401).send({ error: { code: 'HANDS_AUTH', message: 'invalid hands token', traceId } });
        }
        if (body.inputSeq > auth.lastUserSeq) {
          return reply
            .code(400)
            .send(errorEnvelope('VALIDATION_FAILED', 'inputSeq is beyond the session last_user_seq', traceId));
        }
        const res = await engine.execute(
          { sessionId: auth.sessionId, userId: auth.userId },
          {
            name: body.name,
            input: body.input,
            toolCallId: body.toolCallId,
            runId: body.runId,
            inputSeq: body.inputSeq,
          },
        );
        // one line per call: tool, duration, result code — never the arguments (A-01 §5.5)
        req.log.info(
          { tool: body.name, ms: Date.now() - started, code: res.ok ? 'OK' : res.error.code, traceId },
          'tool executed',
        );
        return res;
      });
    },
  };
}

export async function buildHandsServer(o: HandsServerOptions): Promise<FastifyInstance> {
  return buildServer(handsServerOptions(o));
}
