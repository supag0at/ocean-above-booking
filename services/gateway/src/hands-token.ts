// hands token signer (A-01 §5.3, S-2): JWS compact serialization, EdDSA (Ed25519), no JWT library.
// header { alg: "EdDSA", typ: "JWT", kid }, claims { iss: "gateway", aud: "hands", sid, uid, iat, exp: iat+300, jti }.
// kid = first 8 hex chars of sha256(SPKI DER of the public key), so hands can trust old + new keys while rotating.
// NOTE: A-01 §5.3 places the codec in @fb/contracts/server; T01 did not ship it, so the signer lives here and
// follows RFC 7515 / RFC 8037 exactly (reported to the parent session).
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';

export const HANDS_TOKEN_TTL_SECONDS = 300;

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

export interface HandsTokenSigner {
  readonly kid: string;
  sign(claims: { sid: string; uid: string }, nowMs?: number): { token: string; expiresAt: string };
}

export function keyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 8);
}

export function createHandsTokenSigner(privateKeyPem: string): HandsTokenSigner {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('hands_token_signing_key must be an Ed25519 private key');
  const kid = keyId(createPublicKey(key));
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  return {
    kid,
    sign({ sid, uid }, nowMs = Date.now()) {
      const iat = Math.floor(nowMs / 1000);
      const exp = iat + HANDS_TOKEN_TTL_SECONDS;
      const claims = { iss: 'gateway', aud: 'hands', sid, uid, iat, exp, jti: randomBytes(16).toString('hex') };
      const input = `${header}.${b64url(JSON.stringify(claims))}`;
      const sig = sign(null, Buffer.from(input), key);
      return { token: `${input}.${b64url(sig)}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
  };
}
