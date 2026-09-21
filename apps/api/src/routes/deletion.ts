import type { FastifyInstance } from 'fastify';
import { AssetStatus, ErrorCodes, ObscuraError, notFound, badRequest, queueJobId } from '@obscura/shared';
import { defaultJobOptions } from '../queue.ts';
import { requireClient } from '../app.ts';
import type { Deps } from '../deps.ts';

const REASONS = new Set(['data_subject_request', 'retention', 'operator', 'client_request']);

export function registerDeletionRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * Not a status flag. Enqueues a verified purge that enumerates storage, destroys the
   * content key, re-lists to confirm empty, and signs a record that outlives the asset.
   */
  app.delete('/api/v1/assets/:id', async (req, reply) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string; requested_by?: string };

    const reason = b.reason ?? 'client_request';
    if (!REASONS.has(reason)) {
      throw badRequest(`Unknown reason; expected one of ${[...REASONS].join(', ')}`);
    }

    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) {
      // Already deleted is a success, not a 404: the caller's intent is satisfied.
      const rec = await deps.repos.deletions.byAssetId(id);
      if (rec) return reply.status(200).send({ asset_id: id, status: AssetStatus.DELETED, deletion_record: rec });
      throw notFound(`Asset ${id} not found`);
    }

    // Revoke synchronously so nothing can start playing bytes we are about to remove,
    // even if the worker is backed up.
    const revoked = await deps.repos.sessions.revokeAllForAsset(id, 'asset_deleted');
    await deps.repos.assets.setStatus(id, AssetStatus.DELETING);
    await deps.repos.deletions.open({
      assetId: id, clientId: client.id,
      sourceSha256: asset.source_sha256, assetRoot: asset.asset_root,
      reason, requestedBy: b.requested_by ?? client.name,
    });

    await deps.queue.add('delete', {
      type: 'delete', assetId: id, reason, requestedBy: b.requested_by ?? client.name,
    }, { ...defaultJobOptions, attempts: 5, jobId: queueJobId(`${id}:delete`) });

    await deps.repos.audit.log({
      actorType: 'api_client', actorId: client.id, action: 'asset.deletion.requested',
      targetType: 'asset', targetId: id, meta: { reason, requested_by: b.requested_by ?? null },
    });

    return reply.status(202).send({
      asset_id: id, status: AssetStatus.DELETING, sessions_revoked: revoked,
    });
  });

  /**
   * Keeps working after the asset is gone - that is the point of it. This is the artifact
   * you hand to whoever asked.
   */
  app.get('/api/v1/assets/:id/deletion-record', async (req) => {
    await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const rec = await deps.repos.deletions.byAssetId(id);
    if (!rec) {
      if (await deps.repos.deletions.exists(id)) {
        throw new ObscuraError(ErrorCodes.ASSET_NOT_READY, 'Deletion is still in progress', {
          status: 409, retryable: true,
        });
      }
      throw notFound(`No deletion record for ${id}`);
    }
    return rec;
  });
}
