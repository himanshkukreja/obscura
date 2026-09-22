import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCodes, type PackagingConfig, type ProbeResult, type ResolvedRendition } from '@obscura/shared';
import { run } from './exec.ts';
import { declaredBandwidth } from './ladder.ts';

export interface PackageRenditionOptions {
  /**
   * Tenant brand mark to burn in, already downloaded to a local path. Absent means no
   * logo, and the encode is byte-for-byte what it was before this existed.
   */
  branding?: {
    logoPath: string;
    position: string;
    opacity: number;
    heightPct: number;
  };
  ffmpegPath: string;
  input: string;
  outDir: string;
  rendition: ResolvedRendition;
  probe: ProbeResult;
  packaging: PackagingConfig;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface PackageRenditionResult {
  playlistPath: string;
  initPath: string | null;
  segmentPaths: string[];
}

/**
 * Encode one rung and package it as HLS, UNENCRYPTED.
 *
 * Encryption is applied afterwards by @obscura/encryption rather than by ffmpeg, because
 * ffmpeg's HLS muxer cannot encrypt fMP4/CMAF segments at all - it fails with "Not yet
 * implemented in FFmpeg, patches welcome" and supports encryption only for MPEG-TS.
 * Encrypting ourselves keeps CMAF and keeps key material off disk entirely.
 *
 * The keyframe handling here is the part that must not be changed casually. For ABR
 * switching to work, every rendition needs an IDR frame at the *same* presentation
 * timestamps. FFmpeg will not do that by accident, so we:
 *
 *   - force keyframes on an exact expression pinned to the segment duration
 *   - pin the GOP to that same interval
 *   - disable scene-cut detection, so the encoder cannot insert an unplanned IDR
 *
 * Drop any one of the three and the stream plays fine in casual testing, then stutters on
 * quality switches in production. tests/ asserts identical segment boundaries across rungs.
 */
/**
 * Compose the scale/format chain with a logo overlay.
 *
 * The logo is scaled relative to THIS rung's height rather than given a fixed pixel size,
 * so it occupies the same proportion of the frame at 1080p and at 360p. A fixed size would
 * be a discreet mark on the top rung and cover a third of the bottom one.
 *
 * `format=rgba` before colorchannelmixer is deliberate: the filter multiplies the alpha
 * channel, so the logo needs one. Without it a transparent PNG loses its transparency and
 * arrives as a white box.
 */
export function brandFilter(
  base: string[],
  branding: { position: string; opacity: number; heightPct: number },
  renditionHeight: number,
): string {
  const logoH = Math.max(8, Math.round((renditionHeight * branding.heightPct) / 100));
  const pad = Math.max(6, Math.round(renditionHeight * 0.02));
  const xy: Record<string, string> = {
    'top-left': `${pad}:${pad}`,
    'top-right': `W-w-${pad}:${pad}`,
    'bottom-left': `${pad}:H-h-${pad}`,
    'bottom-right': `W-w-${pad}:H-h-${pad}`,
  };
  const at = xy[branding.position] ?? xy['top-right']!;
  const alpha = Math.min(1, Math.max(0, branding.opacity));
  // The pixel format has to be forced back AFTER the overlay, not before. overlay picks a
  // format that can represent both inputs, and with an RGBA logo that is 4:4:4 - which
  // -profile:v main cannot encode ("main profile doesn't support 4:4:4"). Converting in
  // the base chain does not help, because the overlay undoes it.
  const chain = base.filter((f) => f !== 'format=yuv420p');
  return [
    `[0:v]${chain.join(',')}[v]`,
    `[1:v]scale=-1:${logoH},format=rgba,colorchannelmixer=aa=${alpha}[logo]`,
    `[v][logo]overlay=${at}:format=auto,format=yuv420p[vout]`,
  ].join(';');
}

export async function packageRendition(
  opts: PackageRenditionOptions,
): Promise<PackageRenditionResult> {
  const { rendition: r, packaging, probe: pr, branding } = opts;
  const seg = packaging.segmentDurationSec;
  const fmp4 = packaging.container === 'fmp4';

  await mkdir(opts.outDir, { recursive: true });

  const fps = pr.fpsDen > 0 ? pr.fpsNum / pr.fpsDen : 30;
  const gop = Math.max(1, Math.round(seg * fps));

  const filters = [`scale=${r.width}:${r.height}:flags=bicubic`];
  if (pr.isHdr) {
    // Passing HDR through untouched renders washed out on SDR displays, which is worse
    // than either tone-mapping or rejecting. We tone-map.
    filters.unshift(
      'zscale=transfer=linear:npl=100',
      'tonemap=hable:desat=0',
      'zscale=primaries=bt709:transfer=bt709:matrix=bt709',
    );
  }
  filters.push('format=yuv420p');

  const args: string[] = [
    '-hide_banner', '-nostdin', '-y',
    '-i', opts.input,
  ];

  // A logo is a second input, which means the whole chain has to move from -vf to
  // -filter_complex: -vf only sees one input and silently ignores the other.
  if (branding) args.push('-i', branding.logoPath);

  args.push('-map', branding ? '[vout]' : '0:v:0');
  if (pr.hasAudio) args.push('-map', '0:a:0');

  if (branding) {
    args.push('-filter_complex', brandFilter(filters, branding, r.height));
  } else {
    args.push('-vf', filters.join(','));
  }

  args.push(
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-preset', 'veryfast',
    // Quality-targeted when a CRF is configured, with videoBitrate acting as a ceiling
    // rather than a target. Fixed-bitrate encoding spends the full allowance on every
    // second regardless of how hard the picture is, which on low-motion footage is most
    // of it: measured on a real 720p interview, capped CBR at 2800k produced 2956 kbps
    // at SSIM 0.9950 while CRF 23 produced 1010 kbps at SSIM 0.9879.
    //
    // The ceiling still matters. It bounds peak bitrate so ABR switching stays
    // predictable and the BANDWIDTH the master playlist advertises stays honest.
    ...(r.crf !== undefined
      ? ['-crf', String(r.crf), '-maxrate', r.videoBitrate]
      : ['-b:v', r.videoBitrate, '-maxrate', r.videoBitrate]),
    '-bufsize', `${Math.round(parseInt(r.videoBitrate) * 2)}k`,
    // ── keyframe alignment: all three of these matter ──
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    // ──────────────────────────────────────────────────
  );

  if (pr.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', r.audioBitrate, '-ac', '2', '-ar', '48000');
  }

  args.push(
    '-f', 'hls',
    '-hls_time', String(seg),
    // 1-based, so the names ffmpeg writes match the keys we store and the URIs in the
    // playlist. ffmpeg defaults to 0; renaming on upload instead would silently shift
    // every segment by one - the playlist would ask for seg_00000 (404) and each later
    // request would return its neighbour's bytes.
    '-start_number', '1',
    '-hls_playlist_type', 'vod',
    '-hls_list_size', '0',
    '-hls_segment_type', fmp4 ? 'fmp4' : 'mpegts',
    '-hls_flags', packaging.independentSegments ? 'independent_segments' : '0',
  );
  if (fmp4) args.push('-hls_fmp4_init_filename', 'init.mp4');
  args.push(
    '-hls_segment_filename',
    join(opts.outDir, fmp4 ? 'seg_%05d.m4s' : 'seg_%05d.ts'),
  );
  args.push('-progress', 'pipe:2', join(opts.outDir, 'playlist.m3u8'));

  const totalUs = pr.durationMs * 1000;
  await run(opts.ffmpegPath, args, {
    errorCode: ErrorCodes.TRANSCODING_FAILED,
    signal: opts.signal,
    onStderr: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && totalUs > 0 && opts.onProgress) {
        opts.onProgress(Math.min(1, Number(m[1]) / totalUs));
      }
    },
  });

  const files = await readdir(opts.outDir);
  const segmentPaths = files
    .filter((f) => /^seg_\d{5}\.(m4s|ts)$/.test(f))
    .sort()
    .map((f) => join(opts.outDir, f));

  return {
    playlistPath: join(opts.outDir, 'playlist.m3u8'),
    initPath: fmp4 && files.includes('init.mp4') ? join(opts.outDir, 'init.mp4') : null,
    segmentPaths,
  };
}

export interface MasterPlaylistEntry {
  rendition: ResolvedRendition;
  playlistUri: string;
  codecs?: string;
}

export function buildMasterPlaylist(
  entries: MasterPlaylistEntry[],
  opts: { independentSegments: boolean; subtitles?: { language: string; label: string; uri: string; isDefault: boolean }[] } = { independentSegments: true },
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  if (opts.independentSegments) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');

  const subs = opts.subtitles ?? [];
  for (const s of subs) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${s.label}",` +
      `LANGUAGE="${s.language}",AUTOSELECT=YES,DEFAULT=${s.isDefault ? 'YES' : 'NO'},` +
      `URI="${s.uri}"`,
    );
  }

  // Highest bandwidth last so a player that ignores ordering still starts conservatively.
  const sorted = [...entries].sort(
    (a, b) => declaredBandwidth(a.rendition) - declaredBandwidth(b.rendition),
  );
  for (const e of sorted) {
    const bw = declaredBandwidth(e.rendition);
    const attrs = [
      `BANDWIDTH=${bw}`,
      `RESOLUTION=${e.rendition.width}x${e.rendition.height}`,
      `CODECS="${e.codecs ?? 'avc1.4d401f,mp4a.40.2'}"`,
    ];
    if (subs.length) attrs.push('SUBTITLES="subs"');
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`);
    lines.push(e.playlistUri);
  }
  return lines.join('\n') + '\n';
}

/**
 * Insert `#EXT-X-KEY` so it applies to everything that follows, including the
 * `#EXT-X-MAP` initialisation section - which the spec requires to be encrypted when
 * AES-128 applies, and which hls.js decrypts accordingly.
 */
export function insertKeyTag(playlist: string, tag: string): string {
  const lines = playlist.split(/\r?\n/);
  const mapIdx = lines.findIndex((l) => l.startsWith('#EXT-X-MAP:'));
  const firstInf = lines.findIndex((l) => l.startsWith('#EXTINF:'));
  const at = mapIdx >= 0 ? mapIdx : firstInf >= 0 ? firstInf : lines.length;
  return [...lines.slice(0, at), tag, ...lines.slice(at)].join('\n');
}
