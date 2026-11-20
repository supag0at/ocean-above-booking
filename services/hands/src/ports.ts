// Ports hands depends on (T08). flight-core comes in through the contract interface `FlightCore`;
// memory rules come in through `ProfileBuilder`, whose shape mirrors @fb/memory's `buildProfile` (T10) so the
// real function can be passed as-is at W4 integration. In W3 both are stand-ins under test/fakes/.
import type { FlightCore } from '@fb/contracts/flight';
import type { ProfileSnapshot } from '@fb/contracts/server';

export type { FlightCore };

export type MemoryKey = 'home_city' | 'preferred_language';

/** One `app.user_memories` row (A-01 §3.2). `value === null` is a tombstone. `id` is the DB uuid (M-24). */
export interface MemoryRow {
  id: string;
  userId: string;
  key: MemoryKey;
  value: string | null;
  sourceSessionId: string;
  sourceSeq: number;
  createdAt: string;
}

/** One `app.memory_deletions` row. */
export interface MemoryDeletionRow {
  memoryId: string;
  userId: string;
}

/** The part of a ticket the derived profile needs (A-02 §9.1). */
export interface TicketRow {
  ticketId: string;
  userId: string;
  from: string;
  to: string;
  bookedAt: string;
}

export interface ProfileInput {
  userId: string;
  memories: readonly MemoryRow[];
  deletions: readonly MemoryDeletionRow[];
  tickets: readonly TicketRow[];
  isCityServed: (cityName: string) => boolean;
}

/** Recall rule + derived profile (A-02 §9.3). Implemented by T10 (`buildProfile`); hands only supplies storage. */
export type ProfileBuilder = (input: ProfileInput) => ProfileSnapshot;

export interface HandsDeps {
  readonly flightCore: FlightCore;
  readonly buildProfile: ProfileBuilder;
}
