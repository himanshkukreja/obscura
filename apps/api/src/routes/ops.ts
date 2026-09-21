import type { FastifyInstance } from 'fastify';
import { generateApiKey } from '@obscura/auth';
import { uuidv7 } from '@obscura/shared';
import { notFound } from '@obscura/shared';
import { requireClient } from '../app.ts';
import type { Deps } from '../deps.ts';

export function registerOpsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    try { await deps.db.query('SELECT 1'); checks['database'] = true; } catch { checks['database'] = false; }
    try { await deps.storage.head(deps.cfg.storage.deliveryBucket, '__readyz__'); checks['storage'] = true; }
    catch { checks['storage'] = false; }
    try { await deps.queue.getJobCounts(); checks['queue'] = true; } catch { checks['queue'] = false; }
    const ok = Object.values(checks).every(Boolean);
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });

  app.get('/metrics', async (_req, reply) => {
    const counts = await deps.queue.getJobCounts().catch(() => ({}));
    const { rows } = await deps.db.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM assets GROUP BY status',
    ).catch(() => ({ rows: [] as { status: string; n: number }[] }));
    const { rows: sessions } = await deps.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM playback_sessions WHERE revoked_at IS NULL AND expires_at > now()',
    ).catch(() => ({ rows: [{ n: 0 }] }));

    const lines = [
      '# HELP obscura_assets Total assets by status',
      '# TYPE obscura_assets gauge',
      ...rows.map((r) => `obscura_assets{status="${r.status}"} ${r.n}`),
      '# HELP obscura_active_sessions Active playback sessions',
      '# TYPE obscura_active_sessions gauge',
      `obscura_active_sessions ${sessions[0]?.n ?? 0}`,
      '# HELP obscura_queue_jobs Jobs by queue state',
      '# TYPE obscura_queue_jobs gauge',
      ...Object.entries(counts).map(([k, v]) => `obscura_queue_jobs{state="${k}"} ${v}`),
    ];
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });

  /**
   * Rotate the calling client's own API key.
   *
   * Authorized by the key it replaces, so it needs no bootstrap flag and no separate
   * admin credential: whoever can still authenticate is entitled to a new secret. There
   * was previously no way to do this at all - the only option was minting a new client,
   * which orphans every asset the old one owned, since assets are scoped by client_id.
   *
   * The old key stops working the moment this returns. The new one is shown once.
   */
  app.post('/api/v1/clients/me/rotate', async (req, reply) => {
    const client = await requireClient(deps, req);
    const key = await generateApiKey();
    const ok = await deps.repos.clients.rotateKey(client.id, key.prefix, key.hash);
    if (!ok) throw notFound('Client no longer exists');

    await deps.repos.audit.log({
      actorType: 'api_client', actorId: client.id, action: 'client.key.rotated',
      targetType: 'api_client', targetId: client.id,
    });

    // The only time the new secret is ever returned. It is not recoverable afterwards.
    return reply.status(200).send({
      client_id: client.id, name: client.name, api_key: key.full,
    });
  });

  /**
   * Bootstrap the first API client. Disabled unless ALLOW_CLIENT_BOOTSTRAP is set, because
   * an open key-minting endpoint is an open door.
   */
  app.post('/api/v1/admin/clients', async (req, reply) => {
    if (process.env['ALLOW_CLIENT_BOOTSTRAP'] !== 'true') {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    const b = (req.body ?? {}) as { name?: string; scopes?: string[] };
    const key = await generateApiKey();
    const client = await deps.repos.clients.create({
      id: uuidv7(),
      name: b.name ?? 'default',
      keyPrefix: key.prefix,
      keyHash: key.hash,
      scopes: b.scopes ?? ['operator'],
    });
    // The only time the secret is ever returned. It is not recoverable afterwards.
    return reply.status(201).send({ client_id: client.id, name: client.name, api_key: key.full });
  });
}
