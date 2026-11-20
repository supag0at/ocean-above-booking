// hands token check (A-01 §5.3, M-24): signature/aud/exp via the contract's verifyHandsToken, then the
// sid <-> uid pair is confirmed against app.sessions with fb_hands' read-only columns.
import { createPublicKey, type KeyObject } from 'node:crypto';
import { handsTokenKid, verifyHandsToken } from '@fb/contracts/server';
import { UUID_PATTERN } from '@fb/contracts/web';
import { getSession, type Queryable } from './db.ts';

const UUID = new RegExp(UUID_PATTERN);

export interface Authenticated {
  readonly ok: true;
  readonly sessionId: string;
  readonly userId: string;
  readonly lastUserSeq: number;
}
export type AuthResult = Authenticated | { readonly ok: false; readonly reason: string };

/** kid -> key map from one or more PEM public keys (old + new during rotation). */
export function publicKeyMap(pems: readonly string[]): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const pem of pems) {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('hands token public key must be Ed25519');
    keys.set(handsTokenKid(key), key);
  }
  return keys;
}

export async function authenticate(
  authorization: string | undefined,
  keys: ReadonlyMap<string, KeyObject>,
  db: Queryable,
  nowSec: number,
): Promise<AuthResult> {
  const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization ?? '');
  if (!m?.[1]) return { ok: false, reason: 'missing bearer token' };
  const v = verifyHandsToken(m[1], keys, nowSec);
  if (!v.ok) return { ok: false, reason: v.error };
  const { sid, uid } = v.claims;
  if (!UUID.test(sid) || !UUID.test(uid)) return { ok: false, reason: 'BAD_CLAIMS' };
  const session = await getSession(db, sid);
  if (!session || session.userId !== uid) return { ok: false, reason: 'session/user mismatch' };
  return { ok: true, sessionId: sid, userId: uid, lastUserSeq: session.lastUserSeq };
}
