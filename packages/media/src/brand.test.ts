import { describe, it, expect } from 'vitest';
import { brandFilter } from './hls.ts';

const base = ['scale=1280:720:flags=bicubic', 'format=yuv420p'];
const policy = { position: 'top-right', opacity: 0.75, heightPct: 9 };

describe('brandFilter', () => {
  it('forces the pixel format AFTER the overlay, not before', () => {
    // overlay picks a format that can hold both inputs, which with an RGBA logo is 4:4:4 -
    // and `-profile:v main` cannot encode that. Converting only in the base chain gets
    // undone by the overlay, which is how this failed the first time.
    const f = brandFilter(base, policy, 720);
    expect(f).toMatch(/overlay=[^;]*,format=yuv420p\[vout\]$/);
    expect(f.split(';')[0]).not.toContain('format=yuv420p');
  });

  it('scales the logo to a share of THIS rung, so it looks the same on every rung', () => {
    const big = brandFilter(base, policy, 1080);
    const small = brandFilter(base, policy, 360);
    expect(big).toContain('scale=-1:97');    // 9% of 1080
    expect(small).toContain('scale=-1:32');  // 9% of 360
  });

  it('keeps the logo readable on a tiny rung rather than scaling it to nothing', () => {
    expect(brandFilter(base, { ...policy, heightPct: 1 }, 90)).toContain('scale=-1:8');
  });

  it('places the logo in the requested corner', () => {
    expect(brandFilter(base, { ...policy, position: 'top-left' }, 720)).toMatch(/overlay=\d+:\d+/);
    expect(brandFilter(base, { ...policy, position: 'bottom-right' }, 720)).toContain('overlay=W-w-');
    expect(brandFilter(base, { ...policy, position: 'bottom-right' }, 720)).toContain('H-h-');
  });

  it('falls back to a known corner rather than emitting a broken filter', () => {
    const f = brandFilter(base, { ...policy, position: 'nonsense' }, 720);
    expect(f).toContain('overlay=W-w-');   // the top-right default
  });

  it('clamps opacity into range, because ffmpeg would accept nonsense silently', () => {
    expect(brandFilter(base, { ...policy, opacity: 5 }, 720)).toContain('aa=1');
    expect(brandFilter(base, { ...policy, opacity: -2 }, 720)).toContain('aa=0');
  });

  it('gives the logo an alpha channel before multiplying it', () => {
    // Without format=rgba the colorchannelmixer has no alpha to scale and a transparent
    // PNG arrives as an opaque box.
    expect(brandFilter(base, policy, 720)).toMatch(/format=rgba,colorchannelmixer/);
  });
});
