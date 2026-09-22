import type { FastifyInstance } from 'fastify';
import { generateApiKey } from '@obscura/auth';
import { uuidv7 } from '@obscura/shared';
import { createHash } from 'node:crypto';
import { badRequest, notFound, type BrandingPolicy } from '@obscura/shared';
import { StorageKeys } from '@obscura/storage';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_LOGO_BYTES = 512 * 1024;
const VALID_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
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
   * Upload the calling tenant's brand mark, burned into every rendition of every asset
   * ingested AFTER this call.
   *
   * Deliberately not retroactive. The logo is encoded into the frames, so changing it for
   * existing assets means re-transcoding them — at roughly realtime that is a bill and a
   * queue, not a settings change. Assets keep the mark they were made with, and
   * `assets.branding` records which one that was.
   *
   * Raw PNG body rather than multipart: one file, no fields, and it avoids a multipart
   * parser on a service that otherwise has no file uploads.
   */
  app.put('/api/v1/clients/me/branding/logo', {
    bodyLimit: MAX_LOGO_BYTES,
  }, async (req, reply) => {
    const client = await requireClient(deps, req);
    const body = req.body as Buffer | undefined;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest('Send the logo as a raw PNG body');
    }
    // Magic bytes, not the Content-Type header: the header is whatever the caller says.
    if (!body.subarray(0, 8).equals(PNG_MAGIC)) {
      throw badRequest('Logo must be a PNG. Transparency is what makes an overlay usable.');
    }

    const q = req.query as { position?: string; opacity?: string; height_pct?: string };
    const position = (q.position ?? 'top-right') as BrandingPolicy['position'];
    if (!VALID_POSITIONS.includes(position)) {
      throw badRequest(`position must be one of ${VALID_POSITIONS.join(', ')}`);
    }
    const opacity = q.opacity === undefined ? 0.7 : Number(q.opacity);
    const heightPct = q.height_pct === undefined ? 8 : Number(q.height_pct);
    if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
      throw badRequest('opacity must be between 0 and 1');
    }
    // A logo taller than a quarter of the frame is not a watermark, it is a cover.
    if (!Number.isFinite(heightPct) || heightPct < 1 || heightPct > 25) {
      throw badRequest('height_pct must be between 1 and 25');
    }

    const logoKey = StorageKeys.brandingLogo(client.id);
    await deps.storage.put(deps.cfg.storage.deliveryBucket, logoKey, body, {
      contentType: 'image/png', contentLength: body.length,
      cacheControl: 'private, max-age=0',
    });

    const branding: BrandingPolicy = {
      logoKey,
      // Lets an asset attest which mark it carries, and makes a change detectable.
      logoSha256: createHash('sha256').update(body).digest('hex'),
      position, opacity, heightPct,
    };
    await deps.repos.clients.setBranding(client.id, branding);
    await deps.repos.audit.log({
      actorType: 'api_client', actorId: client.id, action: 'branding.logo.set',
      targetType: 'api_client', targetId: client.id,
      meta: { logoSha256: branding.logoSha256, position, opacity, heightPct },
    });

    return reply.status(200).send({
      logo_sha256: branding.logoSha256, position, opacity, height_pct: heightPct,
      applies_to: 'assets ingested after this point; existing assets keep their current mark',
    });
  });

  app.get('/api/v1/clients/me/branding', async (req) => {
    const client = await requireClient(deps, req);
    const b = await deps.repos.clients.getBranding(client.id);
    return b
      ? { logo_sha256: b.logoSha256, position: b.position, opacity: b.opacity, height_pct: b.heightPct }
      : { logo_sha256: null };
  });

  app.delete('/api/v1/clients/me/branding', async (req) => {
    const client = await requireClient(deps, req);
    await deps.repos.clients.setBranding(client.id, null);
    return { removed: true, note: 'existing assets keep the mark they were encoded with' };
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
