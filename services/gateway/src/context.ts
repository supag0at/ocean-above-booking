// Shared dependencies of the gateway routes, sweeper and SSE hub.
import type { HttpClient } from '@fb/platform/http';
import type { Logger } from '@fb/platform/log';
import type { Redis } from '@fb/platform/redis';
import type { AuthStore } from './auth.ts';
import type { Pool } from './db.ts';
import type { Doorbell, Notifier } from './doorbell.ts';
import type { KeyObject } from 'node:crypto';
import type { SseHub } from './sse.ts';

export interface GatewayContext {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly log: Logger;
  readonly auth: AuthStore;
  readonly doorbell: Doorbell;
  readonly notifier: Notifier;
  readonly sse: SseHub;
  readonly booking: HttpClient;
  readonly handsTokenKey: KeyObject;
  readonly harnessServiceToken: string;
  readonly publicOrigin: string;
  readonly cookieSecure: boolean;
}
