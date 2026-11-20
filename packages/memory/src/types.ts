// Storage-facing row types and the store port (A-01 §3.2, A-02 §9). This package does no IO: hands implements MemoryStore.

export type MemoryKey = 'home_city' | 'preferred_language';
export const MEMORY_KEYS: readonly MemoryKey[] = ['home_city', 'preferred_language'];

/** One `user_memories` row. `value === null` is a tombstone (forget_preference). */
export interface MemoryRow {
  id: string; // m_… (M-19); only compared as an opaque string
  userId: string;
  key: MemoryKey;
  value: string | null;
  sourceSessionId: string;
  sourceSeq: number;
  createdAt: string; // ISO-8601 timestamp
}

/** One `memory_deletions` row (user deleted the memory from the profile panel). */
export interface MemoryDeletionRow {
  memoryId: string;
  userId: string;
}

/** The minimum of a `tickets` row that the derived profile needs. City names are the original `city_name` (A-01 §3.2). */
export interface TicketRow {
  ticketId: string;
  userId: string;
  from: string;
  to: string;
  bookedAt: string; // ISO-8601 timestamp, date part is the first 10 chars
}

/** Port implemented by hands. All reads are scoped to one user; the package still filters by userId defensively. */
export interface MemoryStore {
  listMemories(userId: string): Promise<readonly MemoryRow[]>;
  listDeletions(userId: string): Promise<readonly MemoryDeletionRow[]>;
  listTickets(userId: string): Promise<readonly TicketRow[]>;
}

/** Effective (recalled) preference: the surviving latest row for a key. */
export interface EffectivePreference {
  memoryId: string;
  key: MemoryKey;
  value: string;
  sourceSessionId: string;
  sourceSeq: number;
  createdAt: string;
}
