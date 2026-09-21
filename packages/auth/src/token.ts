import { randomBytes, sign as edSign, verify as edVerify, createHash, type KeyObject } from 'node:crypto';
import {
  ErrorCodes, ObscuraError, b64u, unb64u,
  type PlaybackTokenClaims, type TokenScope,
} from '@obscura/shared';

/**
 * Compact Ed25519-signed playback token.
 *
 * Deliberately not a JWT: no algorithm field means no `alg: none` confusion class, and the
 * header is fixed. Format is `v1.<payload-b64u>.<sig-b64u>`.
 *
 * Stateless validation is what allows the delivery path to be authorized at a CDN edge
 * with no database round trip. The cost is a revocation window equal to the token TTL -
 * bounded by a short TTL and compensated by the key endpoint, which always checks the
 * database.
 */
const PREFIX = 'v1';

export interface IssueOptions {
  sessionId: Buffer;
  assetId: string;
  scope: TokenScope;
  ttlSeconds: number;
  tokenEpoch: number;
  now?: number;
}

export function issueToken(privateKey: KeyObject, o: IssueOptions): { token: string; claims: PlaybackTokenClaims } {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const claims: PlaybackTokenClaims = {
    sid: b64u(o.sessionId),
    aid: o.assetId,
    scope: o.scope,
    iat: now,
    exp: now + o.ttlSeconds,
    jti: b64u(randomBytes(12)),
    ep: o.tokenEpoch,
  };
  const payload = b64u(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64u(edSign(null, Buffer.from(`${PREFIX}.${payload}`, 'utf8'), privateKey));
  return { token: `${PREFIX}.${payload}.${sig}`, claims };
}

export function verifyToken(
  publicKey: KeyObject, token: string, opts: { now?: number } = {},
): PlaybackTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Malformed playback token', { status: 401 });
  }
  const [, payload, sig] = parts;
  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(`${PREFIX}.${payload}`, 'utf8'), publicKey, unb64u(sig!));
  } catch { ok = false; }
  if (!ok) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Playback token signature is invalid', { status: 401 });
  }

  let claims: PlaybackTokenClaims;
  try {
    claims = JSON.parse(unb64u(payload!).toString('utf8')) as PlaybackTokenClaims;
  } catch {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Playback token payload is unreadable', { status: 401 });
  }

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new ObscuraError(ErrorCodes.TOKEN_EXPIRED, 'Playback token has expired', { status: 401 });
  }
  return claims;
}

export function assertScope(claims: PlaybackTokenClaims, required: TokenScope): void {
  if (claims.scope !== 'all' && claims.scope !== required) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, `Token is not valid for ${required} requests`, {
      status: 403,
    });
  }
}

export function assertAsset(claims: PlaybackTokenClaims, assetId: string): void {
  if (claims.aid !== assetId) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Token is scoped to a different asset', {
      status: 403,
    });
  }
}

/** Salted hashes, so "same client?" correlation works without retaining an identifier. */
export function saltedHash(value: string, salt: Buffer): Buffer {
  return createHash('sha256').update(salt).update(value, 'utf8').digest();
}
