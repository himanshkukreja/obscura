import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, basename } from 'node:path';
import { AssetStatus, ObscuraError, ErrorCodes, uuidv7, queueJobId } from '@obscura/shared';
import { packageRendition, parsePlaylist, insertKeyTag } from '@obscura/media';
import { StorageKeys } from '@obscura/storage';
import { sha256, merkleRootHex } from '@obscura/integrity';
import { encryptSegment, keyTag } from '@obscura/encryption';
import type { Ctx } from '../context.ts';
import type { Queue } from 'bullmq';
import type { JobPayload } from '../queue.ts';
import { defaultJobOptions } from '../queue.ts';

/** Placeholder written into the stored playlist; the edge substitutes a session URI. */
export const KEY_URI_PLACEHOLDER = 'obscura:key';

export async function runRendition(
  ctx: Ctx, queue: Queue<JobPayload>,
  args: { assetId: string; rendition: string; jobId: string },
  onProgress: (f: number) => void,
): Promise<void> {
  const { assetId, rendition: name } = args;
  const asset = await ctx.repos.assets.byId(assetId);
  if (!asset) throw new ObscuraError(ErrorCodes.NOT_FOUND, `Asset ${assetId} not found`);
  if (asset.status === AssetStatus.DELETING || asset.status === AssetStatus.DELETED) return;
  if (!asset.probe || !asset.ladder) {
    throw new ObscuraError(ErrorCodes.TRANSCODING_FAILED, 'Asset has not been probed', {
      retryable: true,
    });
  }

  const spec = asset.ladder.find((r) => r.name === name);
  if (!spec) throw new ObscuraError(ErrorCodes.TRANSCODING_FAILED, `Rendition ${name} not in ladder`);

  // Idempotency: a retried job must not redo completed work.
  const existing = (await ctx.repos.renditions.forAsset(assetId)).find((r) => r.name === name);
  if (existing?.status === 'complete' && existing.merkle_root) {
    const head = await ctx.storage.head(asset.delivery_bucket!, existing.playlist_key!);
    if (head) {
      ctx.log.info({ assetId, rendition: name }, 'rendition already complete, skipping');
      await maybeFinalize(ctx, queue, assetId);
      return;
    }
  }

  await ctx.repos.renditions.setStatus(assetId, name, 'running');
  const work = await mkdtemp(join(ctx.cfg.media.workDir, `rend-${name}-`));
  const local = join(work, 'source');
  const outDir = join(work, 'out');

  try {
    const obj = await ctx.storage.get(asset.source_bucket, asset.source_key);
    await pipeline(obj.body, createWriteStream(local));

    // The key is created once by the process job, never here: rendition jobs run
    // concurrently, and lazily creating it lets two of them each mint a key, encrypting
    // different rungs under different keys while the manifest advertises one kid.
    const keyRow = (await ctx.repos.contentKeys.forAsset(assetId))[0];
    if (!keyRow) {
      throw new ObscuraError(
        ErrorCodes.ENCRYPTION_FAILED,
        'No content key for asset; run the process job first',
        { retryable: true },
      );
    }
    const contentKey = await ctx.keys.unwrap(
      { kid: keyRow.kid, ciphertext: keyRow.key_ciphertext, nonce: keyRow.key_nonce,
        tag: keyRow.key_tag, provider: keyRow.provider },
      { assetId, kid: keyRow.kid },
    );

    // Fetch the brand mark this asset was ingested with — not whatever the tenant has
    // configured now. An asset re-encoded after a rebrand must still carry the mark its
    // integrity record attests to.
    let branding: { logoPath: string; position: string; opacity: number; heightPct: number } | undefined;
    if (asset.branding) {
      const logoPath = join(work, 'brand-logo.png');
      const logo = await ctx.storage.get(
        asset.delivery_bucket!, StorageKeys.brandingLogo(asset.client_id),
      );
      const chunks: Buffer[] = [];
      for await (const c of logo.body) chunks.push(c as Buffer);
      await writeFile(logoPath, Buffer.concat(chunks));
      branding = {
        logoPath,
        position: asset.branding.position,
        opacity: asset.branding.opacity,
        heightPct: asset.branding.heightPct,
      };
    }

    // ffmpeg packages UNENCRYPTED: its HLS muxer cannot encrypt fMP4 at all. We apply
    // AES-128 ourselves below, which also keeps key material entirely off disk.
    const result = await packageRendition({
      ffmpegPath: ctx.cfg.media.ffmpegPath,
      input: local,
      outDir,
      rendition: spec,
      probe: asset.probe,
      packaging: ctx.cfg.packaging,
      branding,
      onProgress,
    });

    // ── encrypt, hash, then upload ──
    // Hashes are of the ENCRYPTED bytes as stored, so an auditor can verify what a CDN
    // serves without possessing any content key.
    const bucket = asset.delivery_bucket!;
    const segmentHashes: string[] = [];
    const segmentSizes: number[] = [];
    let bytesTotal = 0;

    for (const [i, segPath] of result.segmentPaths.entries()) {
      const cipher = encryptSegment(await readFile(segPath), contentKey, keyRow.iv);
      segmentHashes.push(sha256(cipher));
      segmentSizes.push(cipher.length);
      bytesTotal += cipher.length;
      const ext = segPath.endsWith('.ts') ? 'ts' : 'm4s';
      await ctx.storage.put(
        bucket, StorageKeys.segment(assetId, name, i + 1, ext), cipher,
        { contentType: ext === 'ts' ? 'video/mp2t' : 'video/iso.segment',
          contentLength: cipher.length,
          cacheControl: 'public, max-age=31536000, immutable' },
      );
    }

    let initSha: string | null = null;
    if (result.initPath) {
      // The init section is encrypted too: the spec requires it when AES-128 applies, and
      // hls.js decrypts it for full-segment AES-CBC.
      const cipher = encryptSegment(await readFile(result.initPath), contentKey, keyRow.iv);
      initSha = sha256(cipher);
      bytesTotal += cipher.length;
      await ctx.storage.put(bucket, StorageKeys.init(assetId, name), cipher,
        { contentType: 'video/mp4', contentLength: cipher.length,
          cacheControl: 'public, max-age=31536000, immutable' });
    }

    contentKey.fill(0); // do not leave key material sitting in a live buffer

    const playlistText = insertKeyTag(
      await readFile(result.playlistPath, 'utf8'),
      keyTag(KEY_URI_PLACEHOLDER, keyRow.iv),
    );
    const parsed = parsePlaylist(playlistText);
    const playlistKey = StorageKeys.playlist(assetId, name);
    const playlistBuf = Buffer.from(playlistText, 'utf8');
    await ctx.storage.put(bucket, playlistKey, playlistBuf, {
      contentType: 'application/vnd.apple.mpegurl',
      contentLength: playlistBuf.length,
      cacheControl: 'private, max-age=0',
    });
    const playlistSha = sha256(playlistBuf);

    // Persist the hashes we just computed. Without this, finalize has to re-download every
    // segment to recompute them - O(bytes) network per asset for data we already had.
    const sidecar = Buffer.from(JSON.stringify({
      rendition: name,
      container: ctx.cfg.packaging.container,
      segments: segmentHashes.map((sha256, i) => ({ index: i, sha256, size: segmentSizes[i] })),
      initSha256: initSha,
      playlistSha256: playlistSha,
    }), 'utf8');
    await ctx.storage.put(bucket, StorageKeys.segmentHashes(assetId, name), sidecar, {
      contentType: 'application/json', contentLength: sidecar.length,
    });

    await ctx.repos.renditions.complete(assetId, name, {
      segmentCount: result.segmentPaths.length,
      segmentDurationMs: ctx.cfg.packaging.segmentDurationSec * 1000,
      durationMs: Math.round(parsed.totalDurationSec * 1000),
      bytesTotal,
      playlistKey,
      playlistSha256: Buffer.from(playlistSha, 'hex'),
      initSha256: initSha ? Buffer.from(initSha, 'hex') : null,
      merkleRoot: Buffer.from(merkleRootHex(segmentHashes), 'hex'),
      contentKeyId: keyRow.id,
    });

    ctx.log.info(
      { assetId, rendition: name, segments: result.segmentPaths.length, bytes: bytesTotal },
      'rendition complete',
    );
    await maybeFinalize(ctx, queue, assetId);
  } catch (e) {
    await ctx.repos.renditions.setStatus(assetId, name, 'failed');
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Finalize runs only when every rendition reports complete. */
async function maybeFinalize(ctx: Ctx, queue: Queue<JobPayload>, assetId: string): Promise<void> {
  const rows = await ctx.repos.renditions.forAsset(assetId);
  if (rows.length === 0 || !rows.every((r) => r.status === 'complete')) return;
  await queue.add('finalize', { type: 'finalize', assetId }, {
    ...defaultJobOptions, jobId: queueJobId(`${assetId}:finalize:${ctx.cfg.pipelineVersion}`),
  });
}

export { stat, basename };
