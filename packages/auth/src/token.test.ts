import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { privateKeyFromSeed, publicKeyFromSeed } from '@obscura/integrity';
import { issueToken, verifyToken, assertScope, assertAsset } from './token.ts';
import { generateApiKey, verifySecret, parseApiKey, hashSecret } from './apikey.ts';

const seed = randomBytes(32);
const priv = privateKeyFromSeed(seed);
const pub = publicKeyFromSeed(seed);
const sid = randomBytes(32);

describe('playback tokens', () => {
  it('round-trips claims', () => {
    const { token, claims } = issueToken(priv, {
      sessionId: sid, assetId: 'a1', scope: 'all', ttlSeconds: 180, tokenEpoch: 0,
    });
    const v = verifyToken(pub, token);
    expect(v.aid).toBe('a1');
    expect(v.jti).toBe(claims.jti);
  });

  it('rejects an expired token', () => {
    const { token } = issueToken(priv, {
      sessionId: sid, assetId: 'a1', scope: 'all', ttlSeconds: 1, tokenEpoch: 0,
      now: Date.now() - 10_000,
    });
    expect(() => verifyToken(pub, token)).toThrow(/expired/i);
  });

  it('rejects a tampered payload', () => {
    const { token } = issueToken(priv, {
      sessionId: sid, assetId: 'a1', scope: 'all', ttlSeconds: 180, tokenEpoch: 0,
    });
    const [p, payload, sig] = token.split('.');
    const bad = Buffer.from(JSON.stringify({ sid: 'x', aid: 'a2', scope: 'all', exp: 9e9, iat: 0, jti: 'j', ep: 0 }))
      .toString('base64url');
    expect(payload).not.toBe(bad);
    expect(() => verifyToken(pub, `${p}.${bad}.${sig}`)).toThrow(/signature/i);
  });

  it('rejects a token signed by another key', () => {
    const other = privateKeyFromSeed(randomBytes(32));
    const { token } = issueToken(other, {
      sessionId: sid, assetId: 'a1', scope: 'all', ttlSeconds: 180, tokenEpoch: 0,
    });
    expect(() => verifyToken(pub, token)).toThrow(/signature/i);
  });

  it('has no algorithm field to confuse - "alg: none" is not expressible', () => {
    const { token } = issueToken(priv, {
      sessionId: sid, assetId: 'a1', scope: 'all', ttlSeconds: 180, tokenEpoch: 0,
    });
    expect(token.startsWith('v1.')).toBe(true);
    const header = Buffer.from(token.split('.')[1]!, 'base64url').toString();
    expect(header).not.toMatch(/"alg"/);
  });

  it('enforces scope and asset binding', () => {
    const { token } = issueToken(priv, {
      sessionId: sid, assetId: 'a1', scope: 'key', ttlSeconds: 180, tokenEpoch: 0,
    });
    const c = verifyToken(pub, token);
    expect(() => assertScope(c, 'key')).not.toThrow();
    expect(() => assertScope(c, 'segment')).toThrow();
    expect(() => assertAsset(c, 'a1')).not.toThrow();
    expect(() => assertAsset(c, 'a2')).toThrow(/different asset/);
  });
});

describe('api keys', () => {
  it('generates, parses and verifies', async () => {
    const k = await generateApiKey();
    const parsed = parseApiKey(k.full);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(k.prefix);
    expect(await verifySecret(parsed!.secret, k.hash)).toBe(true);
    expect(await verifySecret('wrong-secret-value', k.hash)).toBe(false);
  });

  it('never stores the secret in the hash', async () => {
    const h = await hashSecret('super-secret');
    expect(h).not.toContain('super-secret');
    expect(h.startsWith('scrypt$')).toBe(true);
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', 'nope', 'obs__x', 'obs_zz_abc', 'Bearer obs_a_b']) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });
});
