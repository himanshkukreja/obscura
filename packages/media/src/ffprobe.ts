import { createHash } from 'node:crypto';
import { ErrorCodes, ObscuraError, type ProbeResult } from '@obscura/shared';
import { run } from './exec.ts';

interface RawStream {
  codec_type?: string; codec_name?: string;
  width?: number; height?: number;
  r_frame_rate?: string; avg_frame_rate?: string;
  bit_rate?: string; pix_fmt?: string;
  channels?: number; sample_rate?: string;
  color_primaries?: string; color_transfer?: string; color_space?: string;
  side_data_list?: { rotation?: number }[];
  tags?: Record<string, string>;
}
interface RawProbe {
  streams?: RawStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string; size?: string };
}

function parseRate(r: string | undefined): [number, number] {
  if (!r) return [0, 1];
  const [n, d] = r.split('/');
  const num = Number(n ?? 0);
  const den = Number(d ?? 1);
  return den === 0 ? [0, 1] : [num, den];
}

export async function probe(ffprobePath: string, input: string): Promise<ProbeResult> {
  let out: string;
  try {
    const r = await run(ffprobePath, [
      '-v', 'error',
      '-show_streams', '-show_format',
      '-print_format', 'json',
      input,
    ], { timeoutMs: 120_000, errorCode: ErrorCodes.PROBE_FAILED });
    out = r.stdout;
  } catch (e) {
    throw new ObscuraError(ErrorCodes.PROBE_FAILED, 'ffprobe could not read the input', {
      retryable: false, cause: e,
    });
  }

  let raw: RawProbe;
  try { raw = JSON.parse(out) as RawProbe; }
  catch (e) {
    throw new ObscuraError(ErrorCodes.PROBE_FAILED, 'ffprobe returned unparseable output', {
      retryable: false, cause: e,
    });
  }

  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');

  const [fpsNum, fpsDen] = parseRate(v?.avg_frame_rate ?? v?.r_frame_rate);

  // Rotation lives either in side data or in a tag, depending on the container.
  let rotation = 0;
  const sideRot = v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation;
  if (typeof sideRot === 'number') rotation = ((-sideRot % 360) + 360) % 360;
  else if (v?.tags?.['rotate']) rotation = ((Number(v.tags['rotate']) % 360) + 360) % 360;

  const width = v?.width ?? 0;
  const height = v?.height ?? 0;
  const swapped = rotation === 90 || rotation === 270;

  const transfer = v?.color_transfer ?? null;
  const primaries = v?.color_primaries ?? null;
  const isHdr =
    transfer === 'smpte2084' || transfer === 'arib-std-b67' ||
    primaries === 'bt2020';

  return {
    durationMs: Math.round(Number(raw.format?.duration ?? 0) * 1000),
    width, height,
    fpsNum, fpsDen,
    videoCodec: v?.codec_name ?? '',
    audioCodec: a?.codec_name ?? null,
    videoBitrate: v?.bit_rate ? Number(v.bit_rate) : (raw.format?.bit_rate ? Number(raw.format.bit_rate) : null),
    audioBitrate: a?.bit_rate ? Number(a.bit_rate) : null,
    pixelFormat: v?.pix_fmt ?? null,
    audioChannels: a?.channels ?? null,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    rotation,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
    isHdr,
    colorPrimaries: primaries,
    colorTransfer: transfer,
    colorSpace: v?.color_space ?? null,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    formatName: raw.format?.format_name ?? '',
    sizeBytes: raw.format?.size ? Number(raw.format.size) : null,
    raw,
  };
}

export interface ValidateOptions { maxDurationSec: number; allowHdr?: boolean }

/** Reject before spending CPU. Every failure here is non-retryable by definition. */
export function validate(p: ProbeResult, opts: ValidateOptions): void {
  const fail = (m: string, d?: Record<string, unknown>) => {
    throw new ObscuraError(ErrorCodes.VALIDATION_FAILED, m, {
      status: 422, retryable: false, detail: d ?? {},
    });
  };

  if (!p.hasVideo) fail('Input contains no video stream');
  if (p.durationMs <= 0) fail('Input has zero or unknown duration');
  if (p.durationMs > opts.maxDurationSec * 1000) {
    fail(`Input duration exceeds the configured maximum of ${opts.maxDurationSec}s`, {
      durationMs: p.durationMs,
    });
  }
  if (p.displayWidth < 16 || p.displayHeight < 16) {
    fail('Input video dimensions are implausibly small', {
      width: p.displayWidth, height: p.displayHeight,
    });
  }
  if (p.fpsNum <= 0) fail('Input has an unreadable frame rate');
}

export function probeHash(p: ProbeResult): string {
  return createHash('sha256').update(JSON.stringify(p.raw)).digest('hex');
}
