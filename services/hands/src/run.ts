// Process entry (container CMD: `node services/hands/src/run.ts`).
// Wires @fb/flight-core and @fb/memory into startHands. W3 tests keep using test/fakes and do not import this file.
// locations.db is opened read-only inside createFlightCore; a sha256 mismatch throws and startup fails (CT-10).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFlightCore as createRealFlightCore } from '@fb/flight-core';
import { buildProfile as buildRealProfile } from '@fb/memory';
import { startHands } from './main.ts';
import type { CreateFlightCore, ProfileBuilder } from './ports.ts';

// Adapters live only in this process. The two packages are not modified; the shapes already match the ports.
const createFlightCore: CreateFlightCore = (options) => createRealFlightCore(options);

const buildProfile: ProfileBuilder = (input) =>
  buildRealProfile({
    userId: input.userId,
    memories: input.memories,
    deletions: input.deletions,
    tickets: input.tickets,
    isCityServed: input.isCityServed,
  });

export async function main(): Promise<void> {
  const secretsDir = process.env.SECRETS_DIR?.trim();
  const app = await startHands({
    env: process.env,
    createFlightCore,
    buildProfile,
    ...(secretsDir !== undefined && secretsDir !== '' ? { secretsDir } : {}),
  });
  const shutdown = (signal: string): void => {
    process.stderr.write(`hands: shutting down (${signal})\n`);
    void app.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`hands: startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
