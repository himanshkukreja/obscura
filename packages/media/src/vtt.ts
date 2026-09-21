import { ObscuraError, ErrorCodes } from '@obscura/shared';

export interface Cue { startMs: number; endMs: number; text: string }

const ts = (ms: number) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
};

function parseTimestamp(s: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) throw new ObscuraError(ErrorCodes.INVALID_REQUEST, `Unparseable timestamp: ${s}`, { status: 400 });
  const [, h, mm, ss, ms] = m;
  return (Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + Number((ms ?? '0').padEnd(3, '0'));
}

/** SRT and WebVTT differ mainly in the header, the comma, and cue numbering. */
export function parseTimedText(input: string): Cue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const body = text.startsWith('WEBVTT') ? text.slice(text.indexOf('\n') + 1) : text;
  const cues: Cue[] = [];

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    let i = 0;
    if (!lines[i]!.includes('-->')) i++; // skip a cue identifier or SRT index
    const timing = lines[i];
    if (!timing || !timing.includes('-->')) continue;
    const [a, b] = timing.split('-->');
    const startMs = parseTimestamp(a!);
    const endMs = parseTimestamp((b ?? '').split(/\s+/).filter(Boolean)[0] ?? '');
    const content = lines.slice(i + 1).join('\n').trim();
    if (content) cues.push({ startMs, endMs, text: content });
  }

  if (cues.length === 0) {
    throw new ObscuraError(ErrorCodes.INVALID_REQUEST, 'No cues found in subtitle input', { status: 400 });
  }
  return cues.sort((x, y) => x.startMs - y.startMs);
}

export function cuesToVtt(cues: Cue[]): string {
  const out = ['WEBVTT', ''];
  for (const c of cues) {
    out.push(`${ts(c.startMs)} --> ${ts(c.endMs)}`, c.text, '');
  }
  return out.join('\n');
}

/**
 * Split cues into HLS subtitle segments aligned to the media segment duration, so the
 * subtitle rendition switches in step with video. A cue spanning a boundary is emitted in
 * every segment it overlaps, which is what players expect.
 */
export function segmentCues(
  cues: Cue[], segmentSec: number, totalDurationMs: number,
): { index: number; durationSec: number; vtt: string }[] {
  const segMs = segmentSec * 1000;
  const count = Math.max(1, Math.ceil(totalDurationMs / segMs));
  const out: { index: number; durationSec: number; vtt: string }[] = [];

  for (let i = 0; i < count; i++) {
    const from = i * segMs;
    const to = from + segMs;
    const inSeg = cues.filter((c) => c.startMs < to && c.endMs > from);
    // X-TIMESTAMP-MAP keeps VTT time in step with the media timeline.
    const header = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n`;
    const body = inSeg.map((c) => `${ts(c.startMs)} --> ${ts(c.endMs)}\n${c.text}\n`).join('\n');
    out.push({
      index: i + 1,
      durationSec: Math.min(segmentSec, Math.max(0, (totalDurationMs - from) / 1000)),
      vtt: `${header}\n${body}`,
    });
  }
  return out;
}

export function buildSubtitlePlaylist(
  segments: { index: number; durationSec: number }[],
  segmentSec: number,
  uri: (index: number) => string,
): string {
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSec)}`,
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:1',
  ];
  for (const s of segments) {
    lines.push(`#EXTINF:${s.durationSec.toFixed(3)},`, uri(s.index));
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
