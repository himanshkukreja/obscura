import { describe, it, expect, afterEach } from 'vitest';
import { loadLadder, DEFAULT_LADDER, parseCorsOrigins } from './config.ts';

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

describe('parseCorsOrigins', () => {
  it('leaves exact origins as strings', () => {
    expect(parseCorsOrigins('https://a.example.com,https://b.example.com'))
      .toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('matches any subdomain depth, because deployments nest them', () => {
    const [re] = parseCorsOrigins('https://*.senseloaf.ai') as RegExp[];
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('https://obscura.senseloaf.ai')).toBe(true);
    expect(re.test('https://sia.senseloaf.ai')).toBe(true);
    expect(re.test('https://dev.sia.senseloaf.ai')).toBe(true);    // two labels
    expect(re.test('https://a.b.c.senseloaf.ai')).toBe(true);
  });

  it('does not let the wildcard escape the domain', () => {
    const [re] = parseCorsOrigins('https://*.senseloaf.ai') as RegExp[];
    // The dot is escaped and `*` excludes dots, so none of these may pass.
    expect(re.test('https://evil.com')).toBe(false);
    expect(re.test('https://senseloaf.ai.evil.com')).toBe(false);
    expect(re.test('https://notsenseloaf.ai')).toBe(false);
    expect(re.test('https://evil-senseloaf.ai')).toBe(false);
    expect(re.test('https://x.senseloafXai')).toBe(false);
    expect(re.test('http://app.senseloaf.ai')).toBe(false);        // scheme differs
  });

  it('anchors, so a prefix or suffix cannot sneak through', () => {
    const [re] = parseCorsOrigins('https://*.senseloaf.ai') as RegExp[];
    expect(re.test('https://app.senseloaf.ai.attacker.test')).toBe(false);
    expect(re.test('xhttps://app.senseloaf.ai')).toBe(false);
  });

  it('mixes exact and wildcard entries, and ignores blanks', () => {
    const out = parseCorsOrigins('https://exact.example.com, ,https://*.senseloaf.ai');
    expect(out).toHaveLength(2);
    expect(typeof out[0]).toBe('string');
    expect(out[1]).toBeInstanceOf(RegExp);
  });
});
