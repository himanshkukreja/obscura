/**
 * Minimal M3U8 read/rewrite.
 *
 * Stored playlists are canonical: relative segment URIs and a placeholder key URI.
 * The edge rewrites them per session. Keeping stored artifacts identical for every viewer
 * is what makes them hashable, cacheable and free of per-user data.
 */
export interface ParsedPlaylist {
  lines: string[];
  segmentUris: { lineIndex: number; uri: string }[];
  keyLines: number[];
  mapLines: number[];
  targetDuration: number;
  totalDurationSec: number;
}

export function parsePlaylist(text: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/);
  const segmentUris: { lineIndex: number; uri: string }[] = [];
  const keyLines: number[] = [];
  const mapLines: number[] = [];
  let targetDuration = 0;
  let totalDurationSec = 0;

  lines.forEach((line, i) => {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      totalDurationSec += Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      keyLines.push(i);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      mapLines.push(i);
    } else if (line && !line.startsWith('#')) {
      segmentUris.push({ lineIndex: i, uri: line });
    }
  });

  return { lines, segmentUris, keyLines, mapLines, targetDuration, totalDurationSec };
}

export interface RewriteOptions {
  /** Map a stored relative segment URI (e.g. "seg_00001.m4s") to a delivery URL. */
  segmentUri: (uri: string, index: number) => string;
  /** Map the init segment URI. */
  initUri?: (uri: string) => string;
  /** Replacement for the #EXT-X-KEY URI attribute. */
  keyUri?: string;
}

export function rewritePlaylist(text: string, opts: RewriteOptions): string {
  const p = parsePlaylist(text);
  const out = [...p.lines];

  p.segmentUris.forEach((s, idx) => { out[s.lineIndex] = opts.segmentUri(s.uri, idx); });

  if (opts.initUri) {
    for (const i of p.mapLines) {
      out[i] = out[i]!.replace(/URI="([^"]*)"/, (_m, u: string) => `URI="${opts.initUri!(u)}"`);
    }
  }
  if (opts.keyUri !== undefined) {
    for (const i of p.keyLines) {
      out[i] = out[i]!.replace(/URI="[^"]*"/, `URI="${opts.keyUri}"`);
    }
  }
  return out.join('\n');
}

/** Segment boundary timestamps, used by the ABR keyframe-alignment test. */
export function segmentBoundaries(text: string): number[] {
  const p = parsePlaylist(text);
  const out: number[] = [];
  let t = 0;
  for (const line of p.lines) {
    if (line.startsWith('#EXTINF:')) {
      out.push(Number(t.toFixed(3)));
      t += Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    }
  }
  out.push(Number(t.toFixed(3)));
  return out;
}
