import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStatus, ObscuraError, ErrorCodes, uuidv7, ladderConfigHash, queueJobId } from '@obscura/shared';
import { probe, validate, probeHash, selectLadder } from '@obscura/media';
import { HashingStream } from '@obscura/integrity';
import { generateIv } from '@obscura/encryption';
import type { Ctx } from '../context.ts';
import type { Queue } from 'bullmq';
import type { JobPayload } from '../queue.ts';
import { defaultJobOptions } from '../queue.ts';

/**
 * Probe, validate, hash, choose the ladder, then fan out one job per rendition.
 *
 * The source is downloaded once and hashed while the bytes flow, rather than downloaded
 * and then re-read.
 */
export async function runProcess(ctx: Ctx, queue: Queue<JobPayload>, assetId: string): Promise<void> {
  const asset = await ctx.repos.assets.byId(assetId);
  if (!asset) throw new ObscuraError(ErrorCodes.NOT_FOUND, `Asset ${assetId} not found`);
  if (asset.status === AssetStatus.DELETING || asset.status === AssetStatus.DELETED) {
    ctx.log.info({ assetId }, 'skipping process: asset is being deleted');
    return;
  }

  const work = await mkdtemp(join(ctx.cfg.media.workDir, 'probe-'));
  const local = join(work, 'source');

  try {
    await ctx.repos.assets.setStatus(assetId, AssetStatus.VALIDATING);

    // ── download + hash in one pass ──
    const obj = await ctx.storage.get(asset.source_bucket, asset.source_key);
    const hasher = new HashingStream();
    await pipeline(obj.body, hasher, createWriteStream(local));
    const sourceSha256 = hasher.digest;
    const size = hasher.size;

    if (size === 0) {
      throw new ObscuraError(ErrorCodes.VALIDATION_FAILED, 'Source object is empty', {
        status: 422, retryable: false,
      });
    }
    await ctx.repos.assets.setSourceHash(assetId, Buffer.from(sourceSha256, 'hex'), size);

    // ── probe + validate ──
    const p = await probe(ctx.cfg.media.ffprobePath, local);
    validate(p, { maxDurationSec: ctx.cfg.media.maxDurationSec });
    await ctx.repos.assets.setProbe(assetId, p, Buffer.from(probeHash(p), 'hex'));

    // ── ladder ──
    const ladder = selectLadder(p, ctx.cfg.ladder);
    await ctx.repos.assets.setLadder(
      assetId, ladder, ladderConfigHash(ctx.cfg.ladder), ctx.cfg.pipelineVersion,
    );
    ctx.log.info(
      { assetId, source: `${p.displayWidth}x${p.displayHeight}`, ladder: ladder.map((r) => r.name) },
      'ladder selected',
    );

    for (const r of ladder) {
      await ctx.repos.renditions.upsertPending(uuidv7(), assetId, r);
    }

    // Create the ONE content key here, before any rendition job exists.
    //
    // This must not be done lazily inside the rendition job: those run concurrently, so
    // two of them can both observe "no key yet" and both create one. The renditions then
    // get encrypted under different keys while the manifest advertises a single kid, and
    // playback fails for whichever rendition lost the race. One key per asset is also what
    // makes deletion a single unambiguous act (see encryption.md §7).
    if ((await ctx.repos.contentKeys.forAsset(assetId)).length === 0) {
      const ck = await ctx.keys.generateContentKey();
      const wrapped = await ctx.keys.wrap(ck.key, { assetId, kid: ck.kid });
      ck.key.fill(0);
      await ctx.repos.contentKeys.create({
        id: uuidv7(), assetId, kid: ck.kid, ciphertext: wrapped.ciphertext,
        nonce: wrapped.nonce, tag: wrapped.tag, provider: wrapped.provider, iv: generateIv(),
      });
    }

    await ctx.repos.assets.setStatus(assetId, AssetStatus.PROCESSING);

    // Renditions are independent and idempotent, so a failure costs only the failed rung.
    for (const r of ladder) {
      const idem = `${assetId}:rendition:${r.name}:${ctx.cfg.pipelineVersion}`;
      const jobId = uuidv7();
      await ctx.repos.jobs.upsert({
        id: jobId, assetId, type: 'rendition', target: r.name, idempotencyKey: idem,
      });
      await queue.add('rendition',
        { type: 'rendition', assetId, rendition: r.name, jobId },
        { ...defaultJobOptions, jobId: queueJobId(idem) },
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
