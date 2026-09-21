import { ObscuraError, ErrorCodes, uuidv7 } from '@obscura/shared';
import { parseTimedText, segmentCues, buildSubtitlePlaylist } from '@obscura/media';
import { StorageKeys } from '@obscura/storage';
import { sha256, merkleRootHex } from '@obscura/integrity';
import type { Ctx } from '../context.ts';

/**
 * Turn timed text into an HLS subtitle rendition.
 *
 * Any platform that already transcribes its media gets this nearly free, and viewers skim
 * transcripts more than they watch video.
 */
export async function runSubtitles(
  ctx: Ctx,
  args: { assetId: string; trackId: string; language: string; label: string | null; isDefault: boolean; origin: string; vtt: string },
): Promise<void> {
  const asset = await ctx.repos.assets.byId(args.assetId);
  if (!asset) throw new ObscuraError(ErrorCodes.NOT_FOUND, `Asset ${args.assetId} not found`);
  const bucket = asset.delivery_bucket!;
  const durationMs = asset.duration_ms ?? 0;
  if (durationMs <= 0) {
    throw new ObscuraError(ErrorCodes.INVALID_REQUEST, 'Asset must be probed before subtitles', {
      retryable: true,
    });
  }

  const cues = parseTimedText(args.vtt);
  const segs = segmentCues(cues, ctx.cfg.packaging.segmentDurationSec, durationMs);

  const hashes: string[] = [];
  for (const s of segs) {
    const buf = Buffer.from(s.vtt, 'utf8');
    hashes.push(sha256(buf));
    await ctx.storage.put(bucket, StorageKeys.subSegment(args.assetId, args.language, s.index), buf, {
      contentType: 'text/vtt', contentLength: buf.length,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  const playlist = buildSubtitlePlaylist(
    segs, ctx.cfg.packaging.segmentDurationSec,
    (i) => `seg_${String(i).padStart(5, '0')}.vtt`,
  );
  const playlistBuf = Buffer.from(playlist, 'utf8');
  const playlistKey = StorageKeys.subPlaylist(args.assetId, args.language);
  await ctx.storage.put(bucket, playlistKey, playlistBuf, {
    contentType: 'application/vnd.apple.mpegurl', contentLength: playlistBuf.length,
    cacheControl: 'private, max-age=0',
  });

  await ctx.repos.subtitles.upsert({
    id: args.trackId || uuidv7(),
    assetId: args.assetId,
    language: args.language,
    label: args.label,
    isDefault: args.isDefault,
    origin: args.origin,
    playlistKey,
    playlistSha256: Buffer.from(sha256(playlistBuf), 'hex'),
    merkleRoot: Buffer.from(merkleRootHex(hashes), 'hex'),
    cueCount: cues.length,
  });

  ctx.log.info(
    { assetId: args.assetId, language: args.language, cues: cues.length, segments: segs.length },
    'subtitle track packaged',
  );
}
