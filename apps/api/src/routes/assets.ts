import type { FastifyInstance } from 'fastify';
import { extname } from 'node:path';
import {
  AssetStatus, ErrorCodes, ObscuraError, uuidv7, badRequest, notFound, conflict, queueJobId } from '@obscura/shared';
import { StorageKeys } from '@obscura/storage';
import { defaultJobOptions } from '../queue.ts';
import { requireClient } from '../app.ts';
import type { Deps } from '../deps.ts';

const SAFE_EXT = /^\.[A-Za-z0-9]{1,5}$/;

export function registerAssetRoutes(app: FastifyInstance, deps: Deps): void {
  // ── create: returns a narrowly scoped, short-lived upload target ──
  app.post('/api/v1/assets', {
    schema: {
      body: {
        type: 'object',
        required: ['original_filename'],
        properties: {
          original_filename: { type: 'string', minLength: 1, maxLength: 512 },
          content_type: { type: 'string', maxLength: 128 },
          size: { type: 'integer', minimum: 0 },
          external_ref: { type: 'string', maxLength: 256 },
          title: { type: 'string', maxLength: 512 },
          ttl_days: { type: 'integer', minimum: 1, maximum: 36500 },
        },
      },
    },
  }, async (req, reply) => {
    const client = await requireClient(deps, req);
    const b = req.body as {
      original_filename: string; content_type?: string; size?: number;
      external_ref?: string; title?: string; ttl_days?: number;
    };

    if (b.size !== undefined && b.size > deps.cfg.uploads.maxBytes) {
      throw badRequest(`Source exceeds the configured maximum of ${deps.cfg.uploads.maxBytes} bytes`);
    }

    const ext = extname(b.original_filename).toLowerCase();
    const safeExt = SAFE_EXT.test(ext) ? ext : '.bin';
    const assetId = uuidv7();
    const sourceKey = StorageKeys.source(assetId, safeExt);

    const asset = await deps.repos.assets.create({
      id: assetId,
      clientId: client.id,
      externalRef: b.external_ref ?? null,
      title: b.title ?? null,
      // Filenames leak personal data into a database column and into operator-facing
      // responses; suppressing them is a supported configuration.
      originalFilename: deps.cfg.privacy.storeOriginalFilename ? b.original_filename : null,
      contentType: b.content_type ?? null,
      sourceBucket: deps.cfg.storage.sourceBucket,
      sourceKey,
      sourceSize: b.size ?? null,
      deliveryBucket: deps.cfg.storage.deliveryBucket,
      expiresAt: b.ttl_days ? new Date(Date.now() + b.ttl_days * 86_400_000) : null,
    }).catch((e: unknown) => {
      if ((e as { code?: string }).code === '23505') {
        throw conflict('An asset with this external_ref already exists', {
          external_ref: b.external_ref,
        });
      }
      throw e;
    });

    const url = await deps.storage.signedUrl(
      deps.cfg.storage.sourceBucket, sourceKey, 'PUT', deps.cfg.uploads.urlTtlSeconds,
      { contentType: b.content_type },
    );

    await deps.repos.audit.log({
      actorType: 'api_client', actorId: client.id, action: 'asset.created',
      targetType: 'asset', targetId: assetId,
    });

    return reply.status(201).send({
      asset_id: asset.id,
      status: asset.status,
      upload: {
        method: 'PUT',
        url,
        headers: b.content_type ? { 'Content-Type': b.content_type } : {},
        expires_at: new Date(Date.now() + deps.cfg.uploads.urlTtlSeconds * 1000).toISOString(),
      },
    });
  });

  // ── commit: the trust boundary. Nothing is processed on the client's word. ──
  app.post('/api/v1/assets/:id/commit', async (req, reply) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);

    if (asset.status !== AssetStatus.UPLOADING && asset.status !== AssetStatus.FAILED) {
      throw conflict(`Asset is ${asset.status}; only UPLOADING or FAILED can be committed`, {
        status: asset.status,
      });
    }

    const head = await deps.storage.head(asset.source_bucket, asset.source_key);
    if (!head) throw badRequest('No object found at the upload location');
    if (head.size === 0) throw badRequest('Uploaded object is empty');
    if (asset.source_size !== null && asset.source_size !== head.size) {
      throw badRequest('Uploaded object size does not match the declared size', {
        declared: asset.source_size, actual: head.size,
      });
    }

    await deps.repos.assets.setStatus(id, AssetStatus.UPLOADED);
    await deps.queue.add('process', { type: 'process', assetId: id }, {
      ...defaultJobOptions, jobId: queueJobId(`${id}:process:${deps.cfg.pipelineVersion}`),
    });

    return reply.status(202).send({ asset_id: id, status: AssetStatus.UPLOADED });
  });

  app.get('/api/v1/assets', async (req) => {
    const client = await requireClient(deps, req);
    const q = req.query as { status?: string; external_ref?: string; cursor?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25)));
    const { data, nextCursor } = await deps.repos.assets.list(client.id, {
      status: q.status, externalRef: q.external_ref, cursor: q.cursor, limit,
    });
    return {
      data: data.filter((a) => a.status !== AssetStatus.DELETED).map(summary),
      next_cursor: nextCursor,
    };
  });

  app.get('/api/v1/assets/:id', async (req) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);

    // A deleted asset must not look like a live one. The row survives only to carry
    // one-way hashes and timestamps; point the caller at the deletion record instead.
    if (!asset || asset.status === AssetStatus.DELETED) {
      if (await deps.repos.deletions.exists(id)) {
        throw new ObscuraError(ErrorCodes.ASSET_DELETED, 'Asset has been deleted', {
          status: 410,
          detail: { deletion_record: `/api/v1/assets/${id}/deletion-record` },
        });
      }
      throw notFound(`Asset ${id} not found`);
    }
    return summary(asset);
  });

  app.get('/api/v1/assets/:id/status', async (req) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);
    const renditions = await deps.repos.renditions.forAsset(id);
    const jobs = await deps.repos.jobs.forAsset(id);

    const done = renditions.filter((r) => r.status === 'complete').length;
    const running = jobs.find((j) => j.state === 'running');
    const progress = renditions.length
      ? (done + (running?.progress ?? 0) / 100) / renditions.length
      : null;

    return {
      asset_id: id,
      status: asset.status,
      progress: progress === null ? null : Math.min(1, Math.round(progress * 100) / 100),
      renditions: renditions.map((r) => ({
        name: r.name,
        status: r.status,
        progress: jobs.find((j) => j.target === r.name)?.progress ?? null,
      })),
      error_code: asset.error_code,
      retryable: asset.retryable,
      // ffmpeg stderr is never here; it is operator-scoped only.
      failed_target: jobs.find((j) => j.state === 'failed')?.target ?? null,
    };
  });

  app.get('/api/v1/assets/:id/metadata', async (req) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);
    return {
      asset_id: id,
      probe: asset.probe,
      ladder: asset.ladder,
      pipeline_version: asset.pipeline_version,
      duration_ms: asset.duration_ms,
      width: asset.width,
      height: asset.height,
      packaging: deps.cfg.packaging,
    };
  });

  app.post('/api/v1/assets/:id/process', async (req, reply) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const { force } = req.query as { force?: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);
    if (asset.status === AssetStatus.DELETING || asset.status === AssetStatus.DELETED) {
      throw conflict('Asset is being deleted');
    }

    const suffix = force === 'true' ? `:${Date.now()}` : '';
    await deps.queue.add('process', { type: 'process', assetId: id }, {
      ...defaultJobOptions, jobId: queueJobId(`${id}:process:${deps.cfg.pipelineVersion}${suffix}`),
    });
    return reply.status(202).send({ asset_id: id, status: asset.status, queued: true });
  });

  // Operator-scoped: raw ffmpeg output for debugging, never in the public asset response.
  app.get('/api/v1/assets/:id/jobs', async (req) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);
    if (!client.scopes.includes('operator')) {
      throw new ObscuraError(ErrorCodes.FORBIDDEN, 'Requires the operator scope', { status: 403 });
    }
    return { data: await deps.repos.jobs.forAsset(id) };
  });
}

function summary(a: {
  id: string; external_ref: string | null; title: string | null; status: string;
  duration_ms: number | null; width: number | null; height: number | null;
  content_type: string | null; source_size: number | null; source_sha256: Buffer | null;
  asset_root: Buffer | null; created_at: Date; ready_at: Date | null; expires_at: Date | null;
  error_code: string | null; retryable: boolean | null;
}) {
  return {
    asset_id: a.id,
    external_ref: a.external_ref,
    title: a.title,
    status: a.status,
    duration_ms: a.duration_ms,
    width: a.width,
    height: a.height,
    content_type: a.content_type,
    size: a.source_size,
    source_sha256: a.source_sha256?.toString('hex') ?? null,
    asset_root: a.asset_root?.toString('hex') ?? null,
    created_at: a.created_at,
    ready_at: a.ready_at,
    expires_at: a.expires_at,
    error_code: a.error_code,
    retryable: a.retryable,
    // Deliberately absent: source_key, source_bucket, any URL to the original.
  };
}
