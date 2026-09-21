import { mkdir } from 'node:fs/promises';
import { AssetStatus, ObscuraError, ErrorCodes } from '@obscura/shared';
import { ensurePartitions, enforceRetention, migrate } from '@obscura/db';
import { createContext } from './context.ts';
import { createQueue, createWorker, defaultJobOptions, type Job, type JobPayload } from './queue.ts';
import { runProcess } from './jobs/process.ts';
import { runRendition } from './jobs/rendition.ts';
import { runFinalize } from './jobs/finalize.ts';
import { runDelete } from './jobs/delete.ts';
import { runSubtitles } from './jobs/subtitles.ts';

const ctx = createContext();
await mkdir(ctx.cfg.media.workDir, { recursive: true });

if (process.env['WORKER_RUN_MIGRATIONS'] !== 'false') {
  const applied = await migrate(ctx.db);
  if (applied.length) ctx.log.info({ applied }, 'migrations applied');
  await ensurePartitions(ctx.db);
}

const queue = createQueue(ctx.cfg.redis.url);

async function handle(job: Job<JobPayload>): Promise<void> {
  const p = job.data;
  const log = ctx.log.child({ jobId: job.id, type: p.type });

  try {
    switch (p.type) {
      case 'process': {
        log.info({ assetId: p.assetId }, 'processing asset');
        await runProcess(ctx, queue, p.assetId);
        return;
      }
      case 'rendition': {
        await ctx.repos.jobs.start(p.jobId);
        let last = 0;
        await runRendition(ctx, queue, p, (f) => {
          if (f - last < 0.05) return;
          last = f;
          void job.updateProgress(Math.round(f * 100));
          void ctx.repos.jobs.progress(p.jobId, f);
        });
        await ctx.repos.jobs.succeed(p.jobId);
        return;
      }
      case 'finalize': return await runFinalize(ctx, p.assetId);
      case 'subtitles': return await runSubtitles(ctx, p);
      case 'delete': {
        await runDelete(ctx, p);
        return;
      }
      case 'retention': {
        const r = await enforceRetention(ctx.db, ctx.cfg.retention);
        await ensurePartitions(ctx.db);
        log.info(r, 'retention enforced');
        return;
      }
    }
  } catch (e) {
    const err = e instanceof ObscuraError
      ? e
      : new ObscuraError(ErrorCodes.INTERNAL, (e as Error).message, { retryable: true, cause: e });

    const assetId = 'assetId' in p ? p.assetId : null;
    const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts.attempts ?? 1) || !err.retryable;

    log.error(
      { assetId, code: err.code, retryable: err.retryable, attempt: job.attemptsMade + 1, detail: err.detail },
      err.message,
    );

    if (p.type === 'rendition') {
      await ctx.repos.jobs.fail(
        p.jobId, err.code,
        `${err.message}\n${JSON.stringify(err.detail)}`, err.retryable,
      );
    }

    // Only mark the asset FAILED once there is nothing left to try, so a transient error
    // does not surface as a permanent failure to the calling application.
    if (assetId && isFinalAttempt && p.type !== 'delete' && p.type !== 'retention') {
      await ctx.repos.assets.setStatus(assetId, AssetStatus.FAILED, {
        reason: err.message, errorCode: err.code, retryable: err.retryable,
      });
      await ctx.repos.audit.log({
        actorType: 'system', actorId: 'worker', action: 'asset.processing.failed',
        targetType: 'asset', targetId: assetId, meta: { code: err.code },
      });
    }
    if (!err.retryable) {
      // Stop BullMQ retrying something that cannot succeed.
      job.discard();
    }
    throw err;
  }
}

const worker = createWorker(ctx.cfg.redis.url, ctx.cfg.worker.concurrency, handle);

worker.on('completed', (job) => ctx.log.debug({ jobId: job.id }, 'job completed'));
worker.on('failed', (job, err) => ctx.log.warn({ jobId: job?.id, err: err.message }, 'job failed'));

// Retention runs on a schedule; retention that waits for someone to remember is not retention.
await queue.add('retention', { type: 'retention' }, {
  ...defaultJobOptions,
  repeat: { pattern: '17 3 * * *' },
  jobId: 'retention-daily',
});

ctx.log.info(
  { concurrency: ctx.cfg.worker.concurrency, redis: ctx.cfg.redis.url.replace(/\/\/.*@/, '//') },
  'obscura worker started',
);

const shutdown = async (sig: string) => {
  ctx.log.info({ sig }, 'shutting down');
  await worker.close();
  await queue.close();
  await ctx.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
