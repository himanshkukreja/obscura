import type { LadderConfig, ProbeResult, ResolvedRendition } from '@obscura/shared';

function parseBitrate(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s.trim());
  if (!m) throw new Error(`Unparseable bitrate: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'm' ? n * 1_000_000 : unit === 'k' ? n * 1000 : n;
}
const even = (n: number) => (n % 2 === 0 ? n : n - 1);

/**
 * Choose the rungs to actually produce.
 *
 *   - never upscale: a rung taller than the source is dropped outright
 *   - never spend more bits than the source is worth: a rung's bitrate is CLAMPED to the
 *     source's, not used as a reason to drop the rung
 *   - always keep the best resolution the source can support
 *   - always emit at least one rung
 *
 * The clamp matters. An earlier version dropped any rung whose nominal bitrate exceeded
 * the source's, which silently removed the 720p rendition from a 720p source encoded at
 * 2.5 Mbps - the viewer got 480p from an HD upload. Resolution and bitrate are separate
 * decisions and only one of them is a reason to drop a rung.
 *
 * Aspect ratio is preserved by fitting inside the rung box, so portrait and ultrawide
 * sources keep their shape instead of being stretched into 16:9.
 */
export function selectLadder(probe: ProbeResult, cfg: LadderConfig): ResolvedRendition[] {
  const srcW = probe.displayWidth;
  const srcH = probe.displayHeight;
  const cap = probe.videoBitrate !== null ? probe.videoBitrate * cfg.maxBitrateRatio : Infinity;

  const fit = (boxW: number, boxH: number) => {
    const scale = Math.min(boxW / srcW, boxH / srcH);
    return {
      width: Math.max(2, even(Math.round(srcW * scale))),
      height: Math.max(2, even(Math.round(srcH * scale))),
    };
  };

  // Tallest first, so "the best resolution the source supports" is simply the first one
  // that survives the no-upscaling rule.
  const candidates = [...cfg.renditions].sort((a, b) => b.height - a.height);
  const kept: ResolvedRendition[] = [];

  for (const [i, r] of candidates.entries()) {
    const upscales = r.height > srcH;
    if (upscales && !cfg.allowUpscaling) continue;

    const target = parseBitrate(r.videoBitrate);
    const isBestAvailable = kept.length === 0;

    // Below the cap: use the rung as configured. Above it: keep the rung only if it is the
    // best resolution this source can offer, and clamp it. Lower rungs that would all
    // collapse to the same clamped bitrate add nothing and are dropped.
    let bitrate: number;
    if (target <= cap) bitrate = target;
    else if (isBestAvailable) bitrate = Math.round(cap);
    else continue;

    const dims = upscales ? { width: even(r.width), height: even(r.height) } : fit(r.width, r.height);
    kept.push({
      name: r.name,
      width: dims.width,
      height: dims.height,
      videoBitrate: formatBitrate(bitrate),
      audioBitrate: cfg.audioBitrate,
      crf: r.crf ?? cfg.defaultCrf,
    });
    void i;
  }

  // Collapse rungs that fitted to identical dimensions (possible with odd aspect ratios).
  const seen = new Set<string>();
  const deduped = kept.filter((r) => {
    const k = `${r.width}x${r.height}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (deduped.length >= Math.max(1, cfg.minRenditions)) return deduped;

  // Nothing survived: emit the lowest configured rung at the source's own size.
  const lowest = [...cfg.renditions].sort((a, b) => a.height - b.height)[0];
  if (!lowest) throw new Error('Ladder configuration contains no renditions');
  return [{
    name: lowest.name,
    width: Math.max(2, even(srcW)),
    height: Math.max(2, even(srcH)),
    videoBitrate: formatBitrate(Math.min(parseBitrate(lowest.videoBitrate), cap)),
    audioBitrate: cfg.audioBitrate,
    crf: lowest.crf ?? cfg.defaultCrf,
  }];
}

function formatBitrate(n: number): string {
  return `${Math.max(1, Math.round(n / 1000))}k`;
}

export function bitrateToNumber(s: string): number { return parseBitrate(s); }

/** Declared BANDWIDTH for the master playlist: video + audio with a small container margin. */
export function declaredBandwidth(r: ResolvedRendition): number {
  return Math.round((parseBitrate(r.videoBitrate) + parseBitrate(r.audioBitrate)) * 1.1);
}
