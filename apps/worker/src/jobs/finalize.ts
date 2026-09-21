import { AssetStatus, ObscuraError, ErrorCodes, type IntegrityManifest } from '@obscura/shared';
import { buildMasterPlaylist } from '@obscura/media';
import { StorageKeys } from '@obscura/storage';
import { sha256, buildRenditionIntegrity, finalizeManifest, verifyManifest } from '@obscura/integrity';
import type { Ctx } from '../context.ts';

/**
 * Build the master playlist, assemble and sign the integrity manifest, then verify every
 * object we claim exists actually does.
 *
 * READY is a promise, so nothing here is allowed to be optimistic: the final consistency
 * check HEADs every key in the manifest before the status moves.
 */
export async function runFinalize(ctx: Ctx, assetId: string): Promise<void> {
  const asset = await ctx.repos.assets.byId(assetId);
  if (!asset) throw new ObscuraError(ErrorCodes.NOT_FOUND, `Asset ${assetId} not found`);
  if (asset.status === AssetStatus.DELETING || asset.status === AssetStatus.DELETED) return;
  if (!asset.probe || !asset.source_sha256 || !asset.probe_sha256) {
    throw new ObscuraError(ErrorCodes.INTEGRITY_FAILED, 'Asset is missing probe or source hash');
  }

  const bucket = asset.delivery_bucket!;
  await ctx.repos.assets.setStatus(assetId, AssetStatus.PACKAGING);

  const renditions = await ctx.repos.renditions.forAsset(assetId);
  const incomplete = renditions.filter((r) => r.status !== 'complete');
  if (renditions.length === 0 || incomplete.length > 0) {
    throw new ObscuraError(
      ErrorCodes.PACKAGING_FAILED,
      `Cannot finalize: ${incomplete.length} rendition(s) incomplete`,
      { retryable: true },
    );
  }

  const subtitles = await ctx.repos.subtitles.forAsset(assetId);

  // ── master playlist: relative URIs, no tokens. Identical for every viewer. ──
  const master = buildMasterPlaylist(
    renditions.map((r) => ({
      rendition: {
        name: r.name, width: r.width ?? 0, height: r.height ?? 0,
        videoBitrate: r.video_bitrate ?? '1000k', audioBitrate: r.audio_bitrate ?? '128k',
      },
      playlistUri: `${r.name}/playlist.m3u8`,
    })),
    {
      independentSegments: ctx.cfg.packaging.independentSegments,
      subtitles: subtitles.map((s) => ({
        language: s.language, label: s.label ?? s.language,
        uri: `subs/${s.language}/playlist.m3u8`, isDefault: s.is_default,
      })),
    },
  );
  const masterBuf = Buffer.from(master, 'utf8');
  await ctx.storage.put(bucket, StorageKeys.master(assetId), masterBuf, {
    contentType: 'application/vnd.apple.mpegurl',
    contentLength: masterBuf.length,
    cacheControl: 'private, max-age=0',
  });

  // ── integrity manifest ──
  await ctx.repos.assets.setStatus(assetId, AssetStatus.ENCRYPTING);
  const keyRow = (await ctx.repos.contentKeys.forAsset(assetId))[0];

  const renditionIntegrity = [];
  for (const r of renditions) {
    // Hashes are of the encrypted bytes as stored, so verification needs no content key.
    const segments: { index: number; sha256: string; size: number }[] = [];
    let cursor: string | undefined;
    const prefix = StorageKeys.renditionPrefix(assetId, r.name);
    do {
      const page = await ctx.storage.list(bucket, prefix, cursor);
      for (const o of page.objects) {
        const m = /seg_(\d{5})\.(m4s|ts)$/.exec(o.key);
        if (m) segments.push({ index: Number(m[1]) - 1, sha256: '', size: o.size });
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);

    // We stored hashes during the rendition job in the Merkle root; recompute leaf hashes
    // by reading back, so the manifest reflects what is actually in storage right now.
    segments.sort((a, b) => a.index - b.index);
    for (const s of segments) {
      const ext = r.name && (await ctx.storage.head(bucket, StorageKeys.segment(assetId, r.name, s.index + 1, 'm4s'))) ? 'm4s' : 'ts';
      const got = await ctx.storage.get(bucket, StorageKeys.segment(assetId, r.name, s.index + 1, ext));
      const chunks: Buffer[] = [];
      for await (const c of got.body) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      s.sha256 = sha256(buf);
      s.size = buf.length;
    }

    renditionIntegrity.push(buildRenditionIntegrity({
      name: r.name,
      width: r.width ?? 0,
      height: r.height ?? 0,
      method: 'AES-128',
      kid: keyRow ? keyRow.kid.toString('hex') : null,
      playlistSha256: r.playlist_sha256!.toString('hex'),
      initSha256: r.init_sha256 ? r.init_sha256.toString('hex') : null,
      segments,
    }));
  }

  const draft: Omit<IntegrityManifest, 'assetRoot' | 'signature'> = {
    schema: 'obscura.integrity/v1',
    assetId,
    createdAt: new Date().toISOString(),
    pipeline: {
      version: asset.pipeline_version ?? ctx.cfg.pipelineVersion,
      ffmpeg: process.env['FFMPEG_VERSION'] ?? 'unknown',
      ladderConfigSha256: asset.ladder_config_sha256 ?? '',
      packaging: ctx.cfg.packaging,
    },
    source: {
      sha256: asset.source_sha256.toString('hex'),
      size: asset.source_size ?? 0,
      contentType: asset.content_type,
      originalFilename: asset.original_filename,
      probeSha256: asset.probe_sha256.toString('hex'),
    },
    renditions: renditionIntegrity,
    subtitles: subtitles.map((s) => ({
      language: s.language,
      playlistSha256: s.playlist_sha256?.toString('hex') ?? '',
      merkleRoot: s.merkle_root?.toString('hex') ?? '',
    })),
  };

  const manifest = finalizeManifest(draft, ctx.integrityPrivate, ctx.cfg.keys.integrityKeyId);
  if (!verifyManifest(manifest, ctx.integrityPublic).ok) {
    throw new ObscuraError(ErrorCodes.INTEGRITY_FAILED, 'Freshly signed manifest failed verification');
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  await ctx.storage.put(bucket, StorageKeys.integrityJson(assetId), manifestBuf, {
    contentType: 'application/json', contentLength: manifestBuf.length,
  });

  const assetJson = Buffer.from(JSON.stringify({
    assetId, probe: asset.probe, ladder: asset.ladder,
    pipelineVersion: asset.pipeline_version, packaging: ctx.cfg.packaging,
  }, null, 2), 'utf8');
  await ctx.storage.put(bucket, StorageKeys.assetJson(assetId), assetJson, {
    contentType: 'application/json', contentLength: assetJson.length,
  });

  await ctx.repos.assets.setIntegrity(assetId, {
    integrityKey: StorageKeys.integrityJson(assetId),
    assetRoot: Buffer.from(manifest.assetRoot, 'hex'),
    signature: manifest.signature!.value,
    keyId: manifest.signature!.keyId,
  });

  // ── final consistency check: HEAD every key the manifest claims ──
  const claimed: string[] = [StorageKeys.master(assetId), StorageKeys.integrityJson(assetId)];
  for (const r of manifest.renditions) {
    claimed.push(StorageKeys.playlist(assetId, r.name));
    if (r.initSha256) claimed.push(StorageKeys.init(assetId, r.name));
    for (let i = 1; i <= r.segmentCount; i++) {
      claimed.push(StorageKeys.segment(assetId, r.name, i, ctx.cfg.packaging.container === 'fmp4' ? 'm4s' : 'ts'));
    }
  }
  const missing: string[] = [];
  for (const k of claimed) {
    if (!(await ctx.storage.head(bucket, k))) missing.push(k);
  }
  if (missing.length) {
    throw new ObscuraError(
      ErrorCodes.INTEGRITY_FAILED,
      `Refusing READY: ${missing.length} claimed object(s) are missing from storage`,
      { retryable: true, detail: { firstMissing: missing[0] } },
    );
  }

  await ctx.repos.assets.setStatus(assetId, AssetStatus.READY);
  await ctx.repos.audit.log({
    actorType: 'system', actorId: 'worker', action: 'asset.processing.completed',
    targetType: 'asset', targetId: assetId,
    meta: { renditions: manifest.renditions.map((r) => r.name), assetRoot: manifest.assetRoot },
  });
  ctx.log.info({ assetId, assetRoot: manifest.assetRoot }, 'asset READY');
}
