import { describe, it, expect, afterEach } from 'vitest';
import { loadLadder, DEFAULT_LADDER } from './config.ts';

const clear = () => {
  delete process.env['OBSCURA_LADDER'];
  delete process.env['OBSCURA_LADDER_CRF'];
};
afterEach(clear);

describe('loadLadder', () => {
  it('returns the shipped default when nothing is set', () => {
    expect(loadLadder()).toEqual(DEFAULT_LADDER);
  });

  it('merges a partial ladder over the default rather than replacing it wholesale', () => {
    // Setting only renditions must not silently drop maxBitrateRatio and friends.
    process.env['OBSCURA_LADDER'] = JSON.stringify({
      renditions: [{ name: '720p', width: 1280, height: 720, videoBitrate: '1200k', crf: 26 }],
    });
    const l = loadLadder();
    expect(l.renditions).toHaveLength(1);
    expect(l.renditions[0]!.crf).toBe(26);
    expect(l.maxBitrateRatio).toBe(DEFAULT_LADDER.maxBitrateRatio);
    expect(l.audioBitrate).toBe(DEFAULT_LADDER.audioBitrate);
  });

  it('OBSCURA_LADDER_CRF overrides every rung, which is the knob most deployments want', () => {
    process.env['OBSCURA_LADDER_CRF'] = '28';
    const l = loadLadder();
    expect(l.defaultCrf).toBe(28);
    expect(l.renditions.every((r) => r.crf === 28)).toBe(true);
  });

  it('rejects malformed JSON loudly instead of silently using the default', () => {
    process.env['OBSCURA_LADDER'] = '{not json';
    expect(() => loadLadder()).toThrow(/not valid JSON/);
  });

  it('rejects an empty rendition list', () => {
    process.env['OBSCURA_LADDER'] = JSON.stringify({ renditions: [] });
    expect(() => loadLadder()).toThrow(/non-empty/);
  });

  it.each(['-1', '52', 'abc'])('rejects out-of-range CRF %s at boot, not mid-transcode', (v) => {
    process.env['OBSCURA_LADDER_CRF'] = v;
    expect(() => loadLadder()).toThrow(/between 0 and 51/);
  });
});
