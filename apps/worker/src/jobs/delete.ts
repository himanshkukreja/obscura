import { AssetStatus, ObscuraError, ErrorCodes, type DeletionRecord, type DeletionReason } from '@obscura/shared';
import { DELETION_PREFIXES, listAll } from '@obscura/storage';
import { signDeletionRecord, verifyDeletionRecord } from '@obscura/integrity';
import type { Ctx } from '../context.ts';

/**
 * Verified purge.
 *
 * The ordering matters and is not arbitrary:
 *
 *   1. revoke sessions first, so nothing can start playing bytes we are about to remove
 *   2. ENUMERATE STORAGE, not the database - failed jobs leave orphaned objects that a
 *      DB-driven delete would silently miss
 *   3. delete what was found
 *   4. DESTROY the content keys - the decisive step. Anything surviving in a replica,
 *      snapshot or edge cache is AES-128 ciphertext with no key left anywhere.
 *   5. invalidate CDN paths (best effort)
 *   6. redact identifying columns, keeping one-way hashes
 *   7. RE-LIST and assert empty - a delete you do not re-check is a delete you are
 *      guessing about
 *   8. sign a record that outlives the asset
 */
export async function runDelete(
  ctx: Ctx,
  args: { assetId: string; reason: string; requestedBy: string | null },
): Promise<DeletionRecord> {
  const { assetId } = args;
  const asset = await ctx.repos.assets.byId(assetId);
  if (!asset) {
    const existing = await ctx.repos.deletions.byAssetId(assetId);
    if (existing) return existing;
    throw new ObscuraError(ErrorCodes.NOT_FOUND, `Asset ${assetId} not found`);
  }

  const requestedAt = new Date().toISOString();
  await ctx.repos.deletions.open({
    assetId,
    clientId: asset.client_id,
    sourceSha256: asset.source_sha256,
    assetRoot: asset.asset_root,
    reason: args.reason,
    requestedBy: args.requestedBy,
  });
  await ctx.repos.assets.setStatus(assetId, AssetStatus.DELETING);

  // 1 ── revoke first
  const sessionsRevoked = await ctx.repos.sessions.revokeAllForAsset(assetId, 'asset_deleted');

  // 2 ── enumerate storage
  const sourceBucket = asset.source_bucket;
  const deliveryBucket = asset.delivery_bucket ?? asset.source_bucket;
  const targets: { bucket: string; prefixes: string[] }[] = [
    { bucket: sourceBucket, prefixes: [...DELETION_PREFIXES.source(assetId)] },
    { bucket: deliveryBucket, prefixes: [...DELETION_PREFIXES.delivery(assetId)] },
  ];
  if (sourceBucket === deliveryBucket) {
    targets.length = 1;
    targets[0] = {
      bucket: sourceBucket,
      prefixes: [...DELETION_PREFIXES.source(assetId), ...DELETION_PREFIXES.delivery(assetId)],
    };
  }

  let objectsDeleted = 0;
  for (const t of targets) {
    for (const prefix of t.prefixes) {
      const found = await listAll(ctx.storage, t.bucket, prefix);
      if (found.length === 0) continue;
      objectsDeleted += await ctx.storage.delete(t.bucket, found.map((o) => o.key));
    }
  }

  // 4 ── destroy keys. DELETE, not a revoked flag: a flag leaves the material in place.
  const contentKeysDestroyed = await ctx.repos.contentKeys.destroyForAsset(assetId);

  // 5 ── CDN invalidation (best effort; the key destruction is the real guarantee)
  const cdnInvalidation = await invalidateCdn(ctx, assetId);

  // 6 ── redact
  await ctx.repos.assets.redactForDeletion(assetId);

  // 7 ── verify empty
  let remaining = 0;
  for (const t of targets) {
    for (const prefix of t.prefixes) {
      remaining += (await listAll(ctx.storage, t.bucket, prefix)).length;
    }
  }
  const storageVerifiedEmpty = remaining === 0;
  if (!storageVerifiedEmpty) {
    ctx.log.error({ assetId, remaining }, 'deletion verification failed: objects remain');
  }

  // 8 ── attest
  const record = signDeletionRecord({
    schema: 'obscura.deletion/v1',
    assetId,
    sourceSha256: asset.source_sha256?.toString('hex') ?? null,
    assetRoot: asset.asset_root?.toString('hex') ?? null,
    reason: args.reason as DeletionReason,
    requestedBy: args.requestedBy,
    requestedAt,
    completedAt: new Date().toISOString(),
    objectsDeleted,
    storageVerifiedEmpty,
    contentKeysDestroyed,
    cdnInvalidation,
    sessionsRevoked,
  }, ctx.integrityPrivate, ctx.cfg.keys.integrityKeyId);

  if (!verifyDeletionRecord(record, ctx.integrityPublic)) {
    throw new ObscuraError(ErrorCodes.DELETION_FAILED, 'Freshly signed deletion record failed verification');
  }

  await ctx.repos.deletions.complete(assetId, record);
  await ctx.repos.audit.log({
    actorType: 'system', actorId: 'worker', action: 'asset.deleted',
    targetType: 'asset', targetId: assetId,
    meta: { reason: args.reason, objectsDeleted, storageVerifiedEmpty, contentKeysDestroyed },
  });

  ctx.log.info(
    { assetId, objectsDeleted, contentKeysDestroyed, storageVerifiedEmpty, sessionsRevoked },
    'asset deleted',
  );

  if (!storageVerifiedEmpty) {
    // Recorded truthfully above, then failed so the job retries rather than reporting success.
    throw new ObscuraError(
      ErrorCodes.DELETION_FAILED,
      `Deletion verification failed: ${remaining} object(s) remain`,
      { retryable: true },
    );
  }
  return record;
}

async function invalidateCdn(ctx: Ctx, assetId: string) {
  const provider = process.env['CDN_PROVIDER'];
  if (!provider) return { requested: false, provider: null, id: null };
  // Provider-specific invalidation lands with the cdn_signed delivery strategy. Recorded
  // honestly as requested-but-unimplemented rather than silently claimed.
  ctx.log.warn({ assetId, provider }, 'CDN invalidation not implemented for provider');
  return { requested: false, provider, id: null };
}
