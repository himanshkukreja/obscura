import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSegment, decryptSegment, keyTag } from './hls.ts';

const key = randomBytes(16);
const iv = randomBytes(16);

describe('HLS AES-128 segment encryption', () => {
  it('round-trips', () => {
    const plain = randomBytes(10_000);
    const c = encryptSegment(plain, key, iv);
    expect(c.equals(plain)).toBe(false);
    expect(decryptSegment(c, key, iv).equals(plain)).toBe(true);
  });

  it('pads to a 16-byte multiple, as AES-CBC requires', () => {
    for (const n of [0, 1, 15, 16, 17, 1000]) {
      expect(encryptSegment(randomBytes(n), key, iv).length % 16).toBe(0);
    }
  });

  it('produces different ciphertext under a different key', () => {
    const plain = randomBytes(1024);
    expect(encryptSegment(plain, key, iv).equals(encryptSegment(plain, randomBytes(16), iv))).toBe(false);
  });

  it('cannot be decrypted with the wrong key - the basis of cryptographic erasure', () => {
    const c = encryptSegment(randomBytes(4096), key, iv);
    expect(() => decryptSegment(c, randomBytes(16), iv)).toThrow();
  });

  it('rejects wrong-sized key or IV rather than silently truncating', () => {
    expect(() => encryptSegment(Buffer.alloc(4), randomBytes(32), iv)).toThrow(/16 bytes/);
    expect(() => encryptSegment(Buffer.alloc(4), key, randomBytes(8))).toThrow(/16 bytes/);
  });

  it('emits a spec-shaped EXT-X-KEY line', () => {
    const tag = keyTag('https://edge/stream/s_1/key/abcd?t=T', iv);
    expect(tag).toMatch(/^#EXT-X-KEY:METHOD=AES-128,URI="[^"]+",IV=0x[0-9a-f]{32}$/);
  });
});
