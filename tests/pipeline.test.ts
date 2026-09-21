import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  probe, validate, selectLadder, packageRendition, segmentBoundaries, parsePlaylist,
  parseTimedText, segmentCues, buildSubtitlePlaylist, cuesToVtt, rewritePlaylist, insertKeyTag,
} from '@obscura/media';
import { DEFAULT_LADDER, ObscuraError } from '@obscura/shared';
import { sha256File } from '@obscura/integrity';
import { encryptSegment, decryptSegment, keyTag } from '@obscura/encryption';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FF = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FP = process.env['FFPROBE_PATH'] ?? 'ffprobe';
const SEG = 4;

beforeAll(() => {
  if (!existsSync(join(FIXTURES, 'basic-720p.mp4'))) {
    execFileSync('bash', [join(FIXTURES, 'generate.sh')], { stdio: 'inherit' });
  }
});

const fx = (n: string) => join(FIXTURES, n);

describe('probe + validate', () => {
  it('reads a 720p source correctly', async () => {
    const p = await probe(FP, fx('basic-720p.mp4'));
    expect(p.hasVideo).toBe(true);
    expect(p.hasAudio).toBe(true);
    expect(p.displayWidth).toBe(1280);
    expect(p.displayHeight).toBe(720);
    expect(p.videoCodec).toBe('h264');
    expect(p.durationMs).toBeGreaterThan(11_000);
  });

  it('handles a source with no audio stream', async () => {
    const p = await probe(FP, fx('no-audio.mp4'));
    expect(p.hasVideo).toBe(true);
    expect(p.hasAudio).toBe(false);
    expect(() => validate(p, { maxDurationSec: 3600 })).not.toThrow();
  });

  it('reads alternative containers', async () => {
    for (const f of ['clip.mov', 'clip.mkv', 'clip.webm']) {
      const p = await probe(FP, fx(f));
      expect(p.hasVideo, f).toBe(true);
      expect(p.displayWidth, f).toBe(640);
    }
  });

  it('rejects audio-only input, non-retryably', async () => {
    const p = await probe(FP, fx('audio-only.m4a'));
    try {
      validate(p, { maxDurationSec: 3600 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ObscuraError);
      expect((e as ObscuraError).code).toBe('VALIDATION_FAILED');
      expect((e as ObscuraError).retryable).toBe(false);
    }
  });

  it('rejects a corrupt file without crashing', async () => {
    await expect(probe(FP, fx('corrupt.mp4'))).rejects.toThrow(/ffprobe/i);
  });

  it('rejects an over-long source', async () => {
    const p = await probe(FP, fx('basic-720p.mp4'));
    expect(() => validate(p, { maxDurationSec: 1 })).toThrow(/duration exceeds/i);
  });
});

describe('ladder selection against real media', () => {
  it('does not upscale a 360p source', async () => {
    const p = await probe(FP, fx('low-360p.mp4'));
    const l = selectLadder(p, DEFAULT_LADDER);
    expect(l.every((r) => r.height <= 360)).toBe(true);
  });

  it('preserves portrait aspect ratio with even dimensions', async () => {
    const p = await probe(FP, fx('portrait.mp4'));
    for (const r of selectLadder(p, DEFAULT_LADDER)) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
      expect(r.width).toBeLessThan(r.height);
    }
  });
});

describe('HLS packaging', () => {
  let work: string;
  const outputs: Record<string, { playlist: string; dir: string; segments: string[] }> = {};

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'obscura-pkg-'));
    const p = await probe(FP, fx('basic-720p.mp4'));
    const ladder = selectLadder(p, DEFAULT_LADDER);
    expect(ladder.length).toBeGreaterThanOrEqual(2);

    for (const r of ladder) {
      const dir = join(work, r.name);
      const res = await packageRendition({
        ffmpegPath: FF, input: fx('basic-720p.mp4'), outDir: dir,
        rendition: r, probe: p,
        packaging: { segmentDurationSec: SEG, container: 'fmp4', independentSegments: true },
      });
      outputs[r.name] = {
        playlist: await readFile(res.playlistPath, 'utf8'),
        dir,
        segments: res.segmentPaths,
      };
    }
  }, 300_000);

  it('produces fMP4 segments and an init segment per rendition', () => {
    for (const [name, o] of Object.entries(outputs)) {
      expect(o.segments.length, name).toBeGreaterThan(1);
      expect(o.segments.every((s) => s.endsWith('.m4s')), name).toBe(true);
      expect(existsSync(join(o.dir, 'init.mp4')), name).toBe(true);
    }
  });

  /**
   * THE test for Phase 1. Every rendition must have an IDR frame at the same presentation
   * timestamps or ABR switching stutters in production while looking fine in casual
   * testing. Without this assertion, the pipeline is not proven.
   */
  it('aligns segment boundaries identically across every rendition', () => {
    const names = Object.keys(outputs);
    expect(names.length).toBeGreaterThanOrEqual(2);
    const reference = segmentBoundaries(outputs[names[0]!]!.playlist);

    for (const n of names.slice(1)) {
      const b = segmentBoundaries(outputs[n]!.playlist);
      expect(b.length, `${n} segment count`).toBe(reference.length);
      for (let i = 0; i < reference.length; i++) {
        // Encoders land on frame boundaries, so allow a sub-frame tolerance only.
        expect(Math.abs(b[i]! - reference[i]!), `${n} boundary ${i}`).toBeLessThan(0.05);
      }
    }
  });

  it('holds segments to the configured target duration', () => {
    for (const [name, o] of Object.entries(outputs)) {
      const parsed = parsePlaylist(o.playlist);
      expect(parsed.targetDuration, name).toBeLessThanOrEqual(SEG + 1);
      expect(parsed.lines.some((l) => l.startsWith('#EXT-X-MAP:')), name).toBe(true);
    }
  });

  it('is deterministic enough to hash: re-hashing a segment matches', async () => {
    const first = Object.values(outputs)[0]!;
    const a = await sha256File(first.segments[0]!);
    const b = await sha256File(first.segments[0]!);
    expect(a.hex).toBe(b.hex);
    expect(a.size).toBeGreaterThan(0);
  });
});

describe('AES-128 encryption (applied after packaging, not by ffmpeg)', () => {
  it('encrypts segments and the init section so both are unreadable without the key', async () => {
    const work = await mkdtemp(join(tmpdir(), 'obscura-enc-'));
    try {
      const p = await probe(FP, fx('low-360p.mp4'));
      const [r] = selectLadder(p, DEFAULT_LADDER);
      const key = randomBytes(16);
      const iv = randomBytes(16);

      const res = await packageRendition({
        ffmpegPath: FF, input: fx('low-360p.mp4'), outDir: join(work, 'enc'),
        rendition: r!, probe: p,
        packaging: { segmentDurationSec: SEG, container: 'fmp4', independentSegments: true },
      });

      // Plaintext fMP4 starts with a styp/ftyp/moof box.
      const plainSeg = await readFile(res.segmentPaths[0]!);
      expect(plainSeg.subarray(4, 8).toString('latin1')).toMatch(/styp|moof|ftyp/);

      const cipher = encryptSegment(plainSeg, key, iv);
      expect(cipher.subarray(4, 8).toString('latin1')).not.toMatch(/styp|moof|ftyp/);
      expect(cipher.length % 16).toBe(0);
      expect(decryptSegment(cipher, key, iv).equals(plainSeg)).toBe(true);

      // The init section is encrypted too - required by the spec and expected by hls.js.
      const initCipher = encryptSegment(await readFile(res.initPath!), key, iv);
      expect(initCipher.subarray(4, 8).toString('latin1')).not.toMatch(/ftyp|moov/);

      // Cryptographic erasure: destroying the key makes every copy permanently inert.
      expect(() => decryptSegment(cipher, randomBytes(16), iv)).toThrow();

      // Key material must never be written to disk.
      const files = await readdir(join(work, 'enc'));
      expect(files.filter((f) => /key/i.test(f))).toEqual([]);

      const playlist = insertKeyTag(
        await readFile(res.playlistPath, 'utf8'), keyTag('obscura:key', iv),
      );
      const lines = playlist.split('\n');
      const keyIdx = lines.findIndex((l) => l.startsWith('#EXT-X-KEY:'));
      const mapIdx = lines.findIndex((l) => l.startsWith('#EXT-X-MAP:'));
      expect(keyIdx).toBeGreaterThanOrEqual(0);
      // EXT-X-KEY must precede EXT-X-MAP so it applies to the init section.
      expect(keyIdx).toBeLessThan(mapIdx);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('playlist rewriting', () => {
  it('rewrites segment, init and key URIs without touching anything else', () => {
    const stored = [
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="obscura:key",IV=0xabc',
      '#EXTINF:4.000,', 'seg_00001.m4s',
      '#EXTINF:4.000,', 'seg_00002.m4s',
      '#EXT-X-ENDLIST', '',
    ].join('\n');

    const out = rewritePlaylist(stored, {
      segmentUri: (u) => `https://cdn/x/${u}?t=TOKEN`,
      initUri: () => 'https://cdn/x/init.mp4?t=TOKEN',
      keyUri: 'https://edge/stream/s_1/key/abc?t=TOKEN',
    });

    expect(out).toContain('https://cdn/x/seg_00001.m4s?t=TOKEN');
    expect(out).toContain('URI="https://cdn/x/init.mp4?t=TOKEN"');
    expect(out).toContain('URI="https://edge/stream/s_1/key/abc?t=TOKEN"');
    expect(out).toContain('IV=0xabc');
    expect(out).toContain('#EXT-X-TARGETDURATION:4');
    expect(out).not.toContain('obscura:key');
  });
});

describe('subtitles', () => {
  it('parses SRT and WebVTT into the same cues', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nTell me about yourself.\n\n2\n00:00:04,000 --> 00:00:06,000\nSure.\n';
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nTell me about yourself.\n\n00:00:04.000 --> 00:00:06.000\nSure.\n';
    expect(parseTimedText(srt)).toEqual(parseTimedText(vtt));
    expect(parseTimedText(srt)[0]).toMatchObject({ startMs: 1000, endMs: 3500 });
  });

  it('segments cues on the media segment grid and emits a valid playlist', () => {
    const cues = parseTimedText(cuesToVtt([
      { startMs: 0, endMs: 2000, text: 'one' },
      { startMs: 3000, endMs: 9000, text: 'spans a boundary' },
    ]));
    const segs = segmentCues(cues, 4, 12_000);
    expect(segs).toHaveLength(3);
    // A cue crossing a boundary appears in every segment it overlaps.
    expect(segs[0]!.vtt).toContain('spans a boundary');
    expect(segs[1]!.vtt).toContain('spans a boundary');
    expect(segs[0]!.vtt).toContain('X-TIMESTAMP-MAP');

    const pl = buildSubtitlePlaylist(segs, 4, (i) => `seg_${String(i).padStart(5, '0')}.vtt`);
    expect(pl).toContain('#EXT-X-ENDLIST');
    expect(pl).toContain('seg_00001.vtt');
  });

  it('rejects subtitle input with no cues', () => {
    expect(() => parseTimedText('WEBVTT\n\n')).toThrow(/No cues/);
  });
});
