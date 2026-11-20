import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkToolArgs } from '../src/tools/index.ts';
import { HANDS_TOKEN_TTL_SEC, handsTokenKid, signHandsToken, verifyHandsToken } from '../src/server/index.ts';

describe('M-24 checkToolArgs (CT-08, shared by harness and hands)', () => {
  it('accepts valid raw args (precondition)', () => {
    expect(checkToolArgs('resolve_city', { original: '上海', candidates: ['Shanghai'] })).toEqual({ ok: true });
  });
  it('rejects without coercing: number in candidates, extra field, too many candidates', () => {
    expect(checkToolArgs('resolve_city', { original: 'x', candidates: [1] }).ok).toBe(false);
    expect(checkToolArgs('resolve_city', { original: 'x', candidates: ['A'], extra: 1 }).ok).toBe(false);
    expect(checkToolArgs('resolve_city', { original: 'x', candidates: ['A', 'B', 'C', 'D'] }).ok).toBe(false);
  });
  it('rejects unknown tools and reports paths', () => {
    const r = checkToolArgs('book_ticket', {});
    expect(r.ok).toBe(false);
    const r2 = checkToolArgs('resolve_city', { original: 'x', candidates: ['A'], extra: 1 });
    expect(r2.ok === false && r2.errors.length > 0).toBe(true);
  });
});

// Fixed Ed25519 test vector (RFC 8032 §7.1 TEST 1 secret key). Test-only; never used at runtime.
const TEST_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex').toString('base64url'),
  x: Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url'),
} as const;
const priv = createPrivateKey({ key: TEST_JWK, format: 'jwk' });
const pub = createPublicKey(priv);
const SID = '11111111-1111-4111-8111-111111111111';
const UID = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000;

describe('M-24 hands token (A-01 §5.3)', () => {
  const keys = new Map([[handsTokenKid(pub), pub]]);
  const token = signHandsToken({ sid: SID, uid: UID, nowSec: NOW, jti: 'test-jti' }, priv);

  it('is deterministic for fixed inputs (test vector)', () => {
    expect(signHandsToken({ sid: SID, uid: UID, nowSec: NOW, jti: 'test-jti' }, priv)).toBe(token);
    expect(handsTokenKid(pub)).toMatch(/^[0-9a-f]{8}$/);
    expect(handsTokenKid(priv)).toBe(handsTokenKid(pub));
  });
  it('round-trips claims', () => {
    const r = verifyHandsToken(token, keys, NOW + 10);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.claims).toMatchObject({
        iss: 'gateway',
        aud: 'hands',
        sid: SID,
        uid: UID,
        exp: NOW + HANDS_TOKEN_TTL_SEC,
      });
  });
  it('rejects tampering, unknown key, expiry, future iat, garbage', () => {
    const [h, c, s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(c, 'base64url').toString()), uid: SID }),
    ).toString('base64url');
    expect(verifyHandsToken(`${h}.${forged}.${s}`, keys, NOW)).toEqual({ ok: false, error: 'BAD_SIGNATURE' });
    const other = generateKeyPairSync('ed25519').publicKey;
    expect(verifyHandsToken(token, new Map([[handsTokenKid(other), other]]), NOW)).toEqual({
      ok: false,
      error: 'UNKNOWN_KID',
    });
    expect(verifyHandsToken(token, keys, NOW + HANDS_TOKEN_TTL_SEC + 31)).toEqual({ ok: false, error: 'EXPIRED' });
    expect(verifyHandsToken(token, keys, NOW + HANDS_TOKEN_TTL_SEC + 29).ok).toBe(true);
    expect(verifyHandsToken(token, keys, NOW - 31)).toEqual({ ok: false, error: 'NOT_YET_VALID' });
    expect(verifyHandsToken('a.b', keys, NOW)).toEqual({ ok: false, error: 'MALFORMED' });
    expect(verifyHandsToken('a.b.c!', keys, NOW)).toEqual({ ok: false, error: 'MALFORMED' });
  });
});
