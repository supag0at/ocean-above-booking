// Doorbell (A-01 §7.3, D-60, CONTRACT M-7) and post-commit notifications (A-01 §7.1).
// A wake job carries no work description; extra doorbells are harmless. Failures never fail the request:
// the sweeper is the backstop (A-01 §4.3 step 4, §7.4).
import { Queue } from 'bullmq';
import { sweeperWakeJobId, wakeJobId, type WakeJob } from '@fb/contracts/server';
import type { SessionStatus } from '@fb/contracts/web';
import type { Logger } from '@fb/platform/log';
import type { Redis } from '@fb/platform/redis';

export const WAKE_QUEUE = 'harness-wake';
export const WAKE_JOB_NAME = 'wake';
export const sseChannel = (sessionId: string): string => `sse:session:${sessionId}`;
export const SSE_LOGOUT_CHANNEL = 'sse:logout';

export interface Doorbell {
  /** after a user.message commit: jobId wake-{sid}-{seq} */
  ringForMessage(sessionId: string, seq: number, traceparent: string): Promise<boolean>;
  /** sweeper: jobId wake-{sid}-scan-{floor(epochMs/15000)} */
  ringForSweep(sessionId: string, epochMs: number, traceparent: string): Promise<boolean>;
  close(): Promise<void>;
}

export function createDoorbell(connection: Redis, log: Logger): Doorbell {
  const queue = new Queue<WakeJob>(WAKE_QUEUE, { connection });
  queue.on('error', (err) => log.warn({ err: err.message }, 'doorbell queue error'));
  const add = async (jobId: string, data: WakeJob): Promise<boolean> => {
    try {
      await queue.add(WAKE_JOB_NAME, data, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: true,
      });
      return true;
    } catch (err) {
      log.warn({ sessionId: data.sessionId, jobId, err: (err as Error).message }, 'doorbell failed');
      return false;
    }
  };
  return {
    ringForMessage: (sessionId, seq, traceparent) => add(wakeJobId(sessionId, seq), { sessionId, traceparent }),
    ringForSweep: (sessionId, epochMs, traceparent) =>
      add(sweeperWakeJobId(sessionId, epochMs), { sessionId, traceparent }),
    close: () => queue.close(),
  };
}

export interface Notifier {
  /** `{kind:'evt', seq}`: only a "new event" signal; SSE re-reads the row from Postgres (A-01 §4.4) */
  evt(sessionId: string, seq: number): Promise<void>;
  status(sessionId: string, status: SessionStatus): Promise<void>;
}

export function createNotifier(redis: Redis, log: Logger): Notifier {
  const pub = async (sessionId: string, msg: unknown): Promise<void> => {
    try {
      await redis.publish(sseChannel(sessionId), JSON.stringify(msg));
    } catch (err) {
      // SSE clients still catch up on reconnect / gap fill (A-01 §4.4)
      log.warn({ sessionId, err: (err as Error).message }, 'sse publish failed');
    }
  };
  return {
    evt: (sessionId, seq) => pub(sessionId, { kind: 'evt', seq }),
    status: (sessionId, status) => pub(sessionId, { kind: 'status', status }),
  };
}
