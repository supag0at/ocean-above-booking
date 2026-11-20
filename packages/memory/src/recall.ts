// Recall rule (A-01 §3.2, A-02 §9.3, D-32, X-3).
// For each key, look ONLY at the latest row (created_at DESC, id DESC). If that row is a tombstone (value null) or its id
// is in memory_deletions, the key does not exist. We never fall back to an older row.
import { MEMORY_KEYS } from './types.ts';
import type { EffectivePreference, MemoryDeletionRow, MemoryKey, MemoryRow } from './types.ts';

/** Strictly later = "newer". Ordering matches the SQL index: created_at DESC, then id DESC (code-unit compare). */
function isNewer(a: MemoryRow, b: MemoryRow): boolean {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (Number.isNaN(ta)) throw new RangeError(`invalid createdAt on memory ${a.id}`);
  if (Number.isNaN(tb)) throw new RangeError(`invalid createdAt on memory ${b.id}`);
  if (ta !== tb) return ta > tb;
  return a.id > b.id;
}

/**
 * Returns the effective preference per key. Input order is irrelevant.
 * Rows and deletions belonging to other users are ignored.
 */
export function recallPreferences(
  userId: string,
  memories: readonly MemoryRow[],
  deletions: readonly MemoryDeletionRow[],
): Partial<Record<MemoryKey, EffectivePreference>> {
  const deleted = new Set<string>();
  for (const d of deletions) if (d.userId === userId) deleted.add(d.memoryId);

  const latest = new Map<MemoryKey, MemoryRow>();
  for (const row of memories) {
    if (row.userId !== userId) continue;
    if (!MEMORY_KEYS.includes(row.key)) continue; // unknown key: never recalled (the S-6 CHECK should make this impossible)
    const cur = latest.get(row.key);
    if (cur === undefined || isNewer(row, cur)) latest.set(row.key, row);
  }

  const out: Partial<Record<MemoryKey, EffectivePreference>> = {};
  for (const key of MEMORY_KEYS) {
    const row = latest.get(key);
    if (row === undefined) continue;
    if (row.value === null) continue; // tombstone: key does not exist, no fallback
    if (deleted.has(row.id)) continue; // deleted by the user: key does not exist, no fallback
    out[key] = {
      memoryId: row.id,
      key,
      value: row.value,
      sourceSessionId: row.sourceSessionId,
      sourceSeq: row.sourceSeq,
      createdAt: row.createdAt,
    };
  }
  return out;
}
