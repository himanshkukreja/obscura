import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EnvelopeKeyProvider } from './envelope.ts';

const master = randomBytes(32);

describe('EnvelopeKeyProvider', () => {
  it('round-trips a content key', async () => {
    const p = new EnvelopeKeyProvider(master);
    const ck = await p.generateContentKey();
    const w = await p.wrap(ck.key, { assetId: 'asset-1', kid: ck.kid });
    expect(w.ciphertext.equals(ck.key)).toBe(false);
    const back = await p.unwrap(w, { assetId: 'asset-1', kid: ck.kid });
    expect(back.equals(ck.key)).toBe(true);
  });

  it('refuses a key transplanted to a different asset', async () => {
    const p = new EnvelopeKeyProvider(master);
    const ck = await p.generateContentKey();
    const w = await p.wrap(ck.key, { assetId: 'asset-1', kid: ck.kid });
    await expect(p.unwrap(w, { assetId: 'asset-2', kid: ck.kid })).rejects.toThrow(/authentication/);
  });

  it('refuses a tampered ciphertext', async () => {
    const p = new EnvelopeKeyProvider(master);
    const ck = await p.generateContentKey();
    const w = await p.wrap(ck.key, { assetId: 'a', kid: ck.kid });
    w.ciphertext[0] = (w.ciphertext[0]! ^ 0xff);
    await expect(p.unwrap(w, { assetId: 'a', kid: ck.kid })).rejects.toThrow();
  });

  it('cannot unwrap under a different master key - this is what makes deletion final', async () => {
    const p = new EnvelopeKeyProvider(master);
    const ck = await p.generateContentKey();
    const w = await p.wrap(ck.key, { assetId: 'a', kid: ck.kid });
    const other = new EnvelopeKeyProvider(randomBytes(32));
    await expect(other.unwrap(w, { assetId: 'a', kid: ck.kid })).rejects.toThrow();
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => new EnvelopeKeyProvider(randomBytes(16))).toThrow(/32 bytes/);
  });
});
