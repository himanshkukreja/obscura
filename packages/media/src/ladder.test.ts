import { describe, it, expect } from 'vitest';
import { selectLadder } from './ladder.ts';
import { DEFAULT_LADDER, type ProbeResult } from '@obscura/shared';

const p = (w: number, h: number, bitrate: number | null = null): ProbeResult => ({
  durationMs: 60_000, width: w, height: h, fpsNum: 30, fpsDen: 1,
  videoCodec: 'h264', audioCodec: 'aac', videoBitrate: bitrate, audioBitrate: 128_000,
  pixelFormat: 'yuv420p', audioChannels: 2, audioSampleRate: 48_000, rotation: 0,
  displayWidth: w, displayHeight: h, isHdr: false,
  colorPrimaries: null, colorTransfer: null, colorSpace: null,
  hasVideo: true, hasAudio: true, formatName: 'mov,mp4', sizeBytes: 1000, raw: {},
});

describe('selectLadder', () => {
  it('never upscales: a 360p source yields only 360p', () => {
    const l = selectLadder(p(640, 360), DEFAULT_LADDER);
    expect(l.map((r) => r.name)).toEqual(['360p']);
    expect(l[0]!.height).toBe(360);
  });

  it('a 720p source yields every rung at or below 720p', () => {
    const l = selectLadder(p(1280, 720), DEFAULT_LADDER);
    expect(l.map((r) => r.name)).toEqual(['720p', '480p', '360p']);
  });

  it('clamps bitrate rather than dropping the resolution the source supports', () => {
    // A 720p source at 700 kbps must still yield a 720p rendition, encoded within its
    // means. Dropping the rung would hand a 480p stream to someone who uploaded 720p.
    const l = selectLadder(p(1280, 720, 700_000), DEFAULT_LADDER);
    expect(l[0]!.name).toBe('720p');
    expect(l[0]!.height).toBe(720);
    expect(Number(l[0]!.videoBitrate.replace('k', ''))).toBeLessThanOrEqual(770);
  });

  it('keeps a 1080p rung for a genuinely HD source', () => {
    const l = selectLadder(p(1920, 1080, 8_000_000), DEFAULT_LADDER);
    expect(l.map((r) => r.name)).toEqual(['1080p', '720p', '480p', '360p']);
    expect(l[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it('never fabricates 1080p from a 720p upload', () => {
    // This is why the 1080p rung is safe to ship in the default config.
    const l = selectLadder(p(1280, 720, 4_000_000), DEFAULT_LADDER);
    expect(l.some((r) => r.height > 720)).toBe(false);
    expect(l[0]!.height).toBe(720);
  });

  it('spends no more bits than the source is worth', () => {
    const src = 3_000_000;
    for (const r of selectLadder(p(1920, 1080, src), DEFAULT_LADDER)) {
      expect(Number(r.videoBitrate.replace('k', '')) * 1000)
        .toBeLessThanOrEqual(src * DEFAULT_LADDER.maxBitrateRatio + 1);
    }
  });

  it('always emits at least one rung, scaled to the source', () => {
    const l = selectLadder(p(320, 180, 50_000), DEFAULT_LADDER);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ width: 320, height: 180 });
  });

  it('preserves aspect ratio for portrait sources', () => {
    const l = selectLadder(p(720, 1280), DEFAULT_LADDER);
    for (const r of l) {
      expect(Math.abs(r.width / r.height - 720 / 1280)).toBeLessThan(0.02);
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });

  it('carries a constant audio bitrate across every rung', () => {
    const l = selectLadder(p(1280, 720), DEFAULT_LADDER);
    expect(new Set(l.map((r) => r.audioBitrate)).size).toBe(1);
    expect(l[0]!.audioBitrate).toBe('128k');
  });

  it('de-duplicates rungs that collapse to identical dimensions', () => {
    const l = selectLadder(p(1280, 720), {
      ...DEFAULT_LADDER,
      renditions: [
        { name: 'a', width: 1280, height: 720, videoBitrate: '2000k' },
        { name: 'b', width: 1280, height: 720, videoBitrate: '1800k' },
      ],
    });
    expect(l).toHaveLength(1);
  });
});

describe('quality target (CRF)', () => {
  it('carries each rung its configured CRF', () => {
    const l = selectLadder(p(1920, 1080, 8_000_000), DEFAULT_LADDER);
    // Lower rungs get a higher CRF: a smaller picture tolerates more compression at the
    // same perceived quality.
    const byName = Object.fromEntries(l.map((r) => [r.name, r.crf]));
    expect(byName['1080p']).toBe(23);
    expect(byName['360p']).toBe(25);
  });

  it('falls back to defaultCrf when a rung does not set one', () => {
    const cfg = {
      ...DEFAULT_LADDER,
      defaultCrf: 27,
      renditions: [{ name: '720p', width: 1280, height: 720, videoBitrate: '2800k' }],
    };
    const l = selectLadder(p(1280, 720, 3_000_000), cfg);
    expect(l[0]!.crf).toBe(27);
  });

  it('leaves crf undefined when neither is set, so encoding stays fixed-bitrate', () => {
    const cfg = {
      ...DEFAULT_LADDER,
      defaultCrf: undefined,
      renditions: [{ name: '720p', width: 1280, height: 720, videoBitrate: '2800k' }],
    };
    const l = selectLadder(p(1280, 720, 3_000_000), cfg);
    expect(l[0]!.crf).toBeUndefined();
  });

  it('applies the quality target to the source-sized fallback rung too', () => {
    // A source below every configured rung falls through to the "emit the lowest rung at
    // the source's own size" path, which is easy to forget when adding a field.
    const l = selectLadder(p(320, 180, 200_000), DEFAULT_LADDER);
    expect(l).toHaveLength(1);
    expect(l[0]!.crf).toBeDefined();
  });
});
