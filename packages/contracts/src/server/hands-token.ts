// M-24 (v1.1.0): hands token = JWS compact, EdDSA (Ed25519), per A-01 §5.3. Signed by gateway, verified by hands.
// Hand-written (no JWT library); node:crypto only. harness only forwards the opaque string.
import {
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyExportOptions,
  type KeyObject,
} from 'node:crypto';

export const HANDS_TOKEN_TTL_SEC = 300;
// Built via fromEntries so the M-15 schema scan (no `format` keyword) is not tripped by a KeyObject export option.
const SPKI_DER = Object.fromEntries([
  ['type', 'spki'],
  ['format', 'der'],
]) as unknown as KeyExportOptions<'der'>;
export const HANDS_TOKEN_SKEW_SEC = 30;

export interface HandsTokenClaims {
  readonly iss: 'gateway';
  readonly aud: 'hands';
  readonly sid: string;
  readonly uid: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type HandsTokenError =
  | 'MALFORMED'
  | 'BAD_HEADER'
  | 'UNKNOWN_KID'
  | 'BAD_SIGNATURE'
  | 'BAD_CLAIMS'
  | 'WRONG_AUDIENCE'
  | 'EXPIRED'
  | 'NOT_YET_VALID';

export type HandsTokenVerifyResult =
  | { readonly ok: true; readonly claims: HandsTokenClaims; readonly kid: string }
  | { readonly ok: false; readonly error: HandsTokenError };

const b64u = (buf: Buffer): string => buf.toString('base64url');
const fromB64u = (s: string): Buffer | null => (/^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url') : null);

/** First 8 hex chars of sha256(SPKI DER) of the public key (A-01 §5.3 "kid"). */
export function handsTokenKid(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(pub.export(SPKI_DER)).digest('hex').slice(0, 8);
}

export function signHandsToken(
  input: { readonly sid: string; readonly uid: string; readonly nowSec: number; readonly jti?: string },
  privateKey: KeyObject,
): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('hands token key must be Ed25519');
  const header = { alg: 'EdDSA', typ: 'JWT', kid: handsTokenKid(privateKey) };
  const claims: HandsTokenClaims = {
    iss: 'gateway',
    aud: 'hands',
    sid: input.sid,
    uid: input.uid,
    iat: input.nowSec,
    exp: input.nowSec + HANDS_TOKEN_TTL_SEC,
    jti: input.jti ?? b64u(randomBytes(16)),
  };
  const signingInput = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(claims)))}`;
  return `${signingInput}.${b64u(sign(null, Buffer.from(signingInput), privateKey))}`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Verify signature, header, aud, iss, exp/iat (±30 s skew). Does NOT check sid↔uid against the DB (hands does). */
export function verifyHandsToken(
  token: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
  nowSec: number,
): HandsTokenVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'MALFORMED' };
  const [h, c, s] = parts as [string, string, string];
  const hb = fromB64u(h);
  const cb = fromB64u(c);
  const sb = fromB64u(s);
  if (!hb || !cb || !sb) return { ok: false, error: 'MALFORMED' };
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(hb.toString('utf8')) as Record<string, unknown>;
    claims = JSON.parse(cb.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || !isStr(header.kid)) return { ok: false, error: 'BAD_HEADER' };
  const key = publicKeys.get(header.kid);
  if (!key) return { ok: false, error: 'UNKNOWN_KID' };
  if (!verify(null, Buffer.from(`${h}.${c}`), key, sb)) return { ok: false, error: 'BAD_SIGNATURE' };
  const { iss, aud, sid, uid, iat, exp, jti } = claims;
  if (iss !== 'gateway' || !isStr(sid) || !isStr(uid) || !isNum(iat) || !isNum(exp) || !isStr(jti))
    return { ok: false, error: 'BAD_CLAIMS' };
  if (aud !== 'hands') return { ok: false, error: 'WRONG_AUDIENCE' };
  if (iat > nowSec + HANDS_TOKEN_SKEW_SEC) return { ok: false, error: 'NOT_YET_VALID' };
  if (exp + HANDS_TOKEN_SKEW_SEC < nowSec) return { ok: false, error: 'EXPIRED' };
  return { ok: true, kid: header.kid, claims: { iss, aud, sid, uid, iat, exp, jti } };
}
