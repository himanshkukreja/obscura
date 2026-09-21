import { describe, it, expect } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, publicKeyFromRaw } from './sign.ts';
import { buildRenditionIntegrity, finalizeManifest, verifyManifest, signDeletionRecord, verifyDeletionRecord } from './manifest.ts';
import type { IntegrityManifest, DeletionRecord } from '@obscura/shared';

const seed = randomBytes(32);
const priv = privateKeyFromSeed(seed);
const pub = publicKeyFromSeed(seed);

const h = (s: string) => createHash('sha256').update(s).digest('hex');

function draft(): Omit<IntegrityManifest, 'assetRoot' | 'signature'> {
  return {
    schema: 'obscura.integrity/v1',
    assetId: '018f3c1e-0000-7000-8000-000000000001',
    createdAt: '2026-09-21T00:00:00.000Z',
    pipeline: {
      version: '1.0.0', ffmpeg: '8.0', ladderConfigSha256: h('ladder'),
      packaging: { segmentDurationSec: 4, container: 'fmp4', independentSegments: true },
    },
    source: {
      sha256: h('source'), size: 1234, contentType: 'video/mp4',
      originalFilename: 'a.mp4', probeSha256: h('probe'),
    },
    renditions: [
      buildRenditionIntegrity({
        name: '720p', width: 1280, height: 720, method: 'AES-128', kid: 'aabb',
        playlistSha256: h('pl'), initSha256: h('init'),
        segments: [
          { index: 0, sha256: h('s0'), size: 10 },
          { index: 1, sha256: h('s1'), size: 11 },
          { index: 2, sha256: h('s2'), size: 12 },
        ],
      }),
    ],
    subtitles: [],
  };
}

describe('integrity manifest', () => {
  it('signs and verifies', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    expect(verifyManifest(m, pub)).toEqual({ ok: true });
  });

  it('survives re-serialisation with different key ordering', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    const shuffled = JSON.parse(JSON.stringify({
      signature: m.signature, assetRoot: m.assetRoot, subtitles: m.subtitles,
      renditions: m.renditions, source: m.source, pipeline: m.pipeline,
      createdAt: m.createdAt, assetId: m.assetId, schema: m.schema,
    })) as IntegrityManifest;
    expect(verifyManifest(shuffled, pub)).toEqual({ ok: true });
  });

  it('detects a tampered segment hash', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    m.renditions[0]!.segments[1]!.sha256 = h('tampered');
    expect(verifyManifest(m, pub).ok).toBe(false);
  });

  it('detects a swapped asset root', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    m.assetRoot = h('other');
    expect(verifyManifest(m, pub)).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects verification under a different key', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    expect(verifyManifest(m, publicKeyFromSeed(randomBytes(32))).ok).toBe(false);
  });

  it('reports a missing signature distinctly', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    delete (m as { signature?: unknown }).signature;
    expect(verifyManifest(m, pub)).toMatchObject({ ok: false, reason: 'no_signature' });
  });

  it('round-trips a raw public key, so third parties can verify from the JWKS', () => {
    const m = finalizeManifest(draft(), priv, 'k1');
    expect(verifyManifest(m, publicKeyFromRaw(rawPublicKey(pub)))).toEqual({ ok: true });
  });

  it('signs a deletion record with the same key', () => {
    const rec: Omit<DeletionRecord, 'signature'> = {
      schema: 'obscura.deletion/v1',
      assetId: 'a1', sourceSha256: h('source'), assetRoot: h('root'),
      reason: 'data_subject_request', requestedBy: 'privacy@example.com',
      requestedAt: '2026-09-21T00:00:00.000Z', completedAt: '2026-09-21T00:00:41.000Z',
      objectsDeleted: 1843, storageVerifiedEmpty: true, contentKeysDestroyed: 1,
      cdnInvalidation: null, sessionsRevoked: 3,
    };
    const signed = signDeletionRecord(rec, priv, 'k1');
    expect(verifyDeletionRecord(signed, pub)).toBe(true);
    signed.objectsDeleted = 0;
    expect(verifyDeletionRecord(signed, pub)).toBe(false);
  });
});
