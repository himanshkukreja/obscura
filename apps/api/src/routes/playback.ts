import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AssetStatus, ErrorCodes, ObscuraError, notFound, badRequest,
  sessionId as newSessionId, formatSessionId, parseSessionId, shortId,
  type PlaybackSessionResponse,
} from '@obscura/shared';
import { issueToken, saltedHash } from '@obscura/auth';
import { renderWatermark } from '@obscura/delivery';
import { requireClient } from '../app.ts';
import type { Deps } from '../deps.ts';

export function registerPlaybackRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/api/v1/assets/:id/playback-session', {
    schema: {
      body: {
        type: 'object',
        required: ['subject_ref'],
        properties: {
          subject_ref: { type: 'string', minLength: 1, maxLength: 256 },
          subject_label: { type: 'string', maxLength: 256 },
          ttl_seconds: { type: 'integer', minimum: 60, maximum: 86_400 },
          client_binding: { type: 'string', maxLength: 512 },
          watermark: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              text_template: { type: 'string', maxLength: 256 },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const b = req.body as {
      subject_ref: string; subject_label?: string; ttl_seconds?: number;
      client_binding?: string; watermark?: { enabled?: boolean; text_template?: string };
    };

    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);
    if (asset.status !== AssetStatus.READY) {
      throw new ObscuraError(ErrorCodes.ASSET_NOT_READY, `Asset is ${asset.status}`, {
        status: 409, retryable: asset.status !== AssetStatus.FAILED,
        detail: { status: asset.status },
      });
    }

    // Concurrent-session limit: makes credential sharing painful and is reported with a
    // distinguishable code so your UI can say something better than "failed".
    const limit = deps.cfg.playback.maxConcurrentSessionsPerSubject;
    if (limit !== null && limit > 0) {
      const active = await deps.repos.sessions.countActive(client.id, b.subject_ref);
      if (active >= limit) {
        return reply.status(429).send({
          error: {
            code: ErrorCodes.CONCURRENT_SESSION_LIMIT,
            message: 'This viewer already has the maximum number of active sessions',
            limit, active, retry_after: 30,
          },
          request_id: req.id,
        });
      }
    }

    const sid = newSessionId();
    const sidStr = formatSessionId(sid);
    const ttl = Math.min(b.ttl_seconds ?? deps.cfg.playback.sessionTtlSeconds, 86_400);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const policy = {
      ...deps.cfg.watermark,
      enabled: b.watermark?.enabled ?? deps.cfg.watermark.enabled,
      textTemplate: b.watermark?.text_template ?? deps.cfg.watermark.textTemplate,
    };
    const watermarkText = policy.enabled
      ? renderWatermark(policy, {
          userLabel: b.subject_label ?? b.subject_ref,
          userRef: b.subject_ref,
          sessionId: sidStr,
          sessionShortId: shortId(sid),
          assetId: asset.id,
          assetShortId: shortId(asset.id),
          orgName: client.name,
        })
      : null;

    const { ip, ua } = privacyFields(deps, req);

    await deps.repos.sessions.create({
      id: sid,
      assetId: asset.id,
      clientId: client.id,
      subjectRef: b.subject_ref,
      subjectLabel: b.subject_label ?? null,
      expiresAt,
      deliveryStrategy: deps.cfg.playback.deliveryStrategy,
      clientBinding: b.client_binding
        ? saltedHash(b.client_binding, deps.cfg.privacy.hashSalt)
        : null,
      ipHash: ip.hash, userAgentHash: ua.hash, ipRaw: ip.raw, userAgentRaw: ua.raw,
      watermarkText,
    });
    await deps.repos.sessions.event(sid, asset.id, 'created', { subject_ref: b.subject_ref });

    const tokenTtl = deps.cfg.playback.tokenTtlSeconds;
    const { token } = issueToken(deps.tokenPrivate, {
      sessionId: sid, assetId: asset.id, scope: 'all', ttlSeconds: tokenTtl, tokenEpoch: 0,
    });

    const body: PlaybackSessionResponse = {
      sessionId: sidStr,
      token,
      manifestUrl: `${deps.cfg.edge.publicUrl}/stream/${sidStr}/master.m3u8?t=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
      tokenExpiresAt: new Date(Date.now() + tokenTtl * 1000).toISOString(),
      // The player should not have to reason about token lifetimes.
      refreshAfter: Math.max(30, Math.floor(tokenTtl * 0.6)),
      watermark: watermarkText === null ? null : {
        enabled: true,
        text: watermarkText,
        position: policy.position,
        intervalSeconds: policy.intervalSeconds,
        opacity: policy.opacity,
        fontSizeVh: policy.fontSizeVh,
        tiled: policy.tiled,
      },
    };

    return reply.status(201).send(toSnake(body));
  });

  app.post('/api/v1/playback/:sid/heartbeat', async (req) => {
    const { sid } = req.params as { sid: string };
    const id = parseSessionId(sid);
    if (!id) throw badRequest('Malformed session id');

    const s = await deps.repos.sessions.byId(id);
    if (!s) throw notFound('Session not found');
    if (s.revoked_at) {
      throw new ObscuraError(ErrorCodes.SESSION_REVOKED, 'Session has been revoked', { status: 401 });
    }
    if (s.expires_at.getTime() <= Date.now()) {
      throw new ObscuraError(ErrorCodes.SESSION_EXPIRED, 'Session has expired', { status: 401 });
    }

    await deps.repos.sessions.touch(id);
    await deps.repos.sessions.event(id, s.asset_id, 'heartbeat');

    const tokenTtl = deps.cfg.playback.tokenTtlSeconds;
    const { token } = issueToken(deps.tokenPrivate, {
      sessionId: id, assetId: s.asset_id, scope: 'all',
      ttlSeconds: tokenTtl, tokenEpoch: s.token_epoch,
    });
    return {
      token,
      token_expires_at: new Date(Date.now() + tokenTtl * 1000).toISOString(),
      expires_at: s.expires_at.toISOString(),
      refresh_after: Math.max(30, Math.floor(tokenTtl * 0.6)),
    };
  });

  app.delete('/api/v1/playback/:sid', async (req) => {
    await requireClient(deps, req);
    const { sid } = req.params as { sid: string };
    const id = parseSessionId(sid);
    if (!id) throw badRequest('Malformed session id');
    const revoked = await deps.repos.sessions.revoke(id, 'client_request');
    if (revoked) await deps.repos.sessions.event(id, null, 'revoked');
    return { session_id: sid, revoked };
  });

  // Bulk revocation by subject: what you reach for when someone leaves or an account is
  // compromised. A first-class endpoint rather than a loop over session ids.
  app.delete('/api/v1/playback/sessions', async (req) => {
    const client = await requireClient(deps, req);
    const { subject_ref } = req.query as { subject_ref?: string };
    if (!subject_ref) throw badRequest('subject_ref is required');
    const n = await deps.repos.sessions.revokeAllForSubject(client.id, subject_ref, 'client_request');
    await deps.repos.audit.log({
      actorType: 'api_client', actorId: client.id, action: 'session.revoked_bulk',
      targetType: 'subject', targetId: subject_ref, meta: { count: n },
    });
    return { subject_ref, revoked: n };
  });

  // Who viewed this asset and when. Watch time is ESTIMATED from heartbeat and key-fetch
  // counts: precise position tracking would be behavioural profiling.
  app.get('/api/v1/assets/:id/access-log', async (req) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const q = req.query as { from?: string; to?: string; cursor?: string; limit?: string };
    const asset = await deps.repos.assets.byIdForClient(id, client.id);
    if (!asset) throw notFound(`Asset ${id} not found`);

    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const { data, nextCursor } = await deps.repos.sessions.accessLog(id, {
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      cursor: q.cursor, limit,
    });

    const hb = deps.cfg.playback.heartbeatIntervalSeconds;
    return {
      data: data.map((r) => ({
        session_id: formatSessionId(r.id),
        subject_ref: r.subject_ref,
        started_at: r.created_at,
        last_seen_at: r.last_seen_at,
        revoked_at: r.revoked_at,
        events: { manifest: r.manifest, key: r.key, heartbeat: r.heartbeat },
        watched_seconds_estimate: r.heartbeat * hb,
      })),
      next_cursor: nextCursor,
    };
  });
}

function privacyFields(deps: Deps, req: FastifyRequest) {
  const { storeIp, storeUserAgent, hashSalt } = deps.cfg.privacy;
  const uaRaw = req.headers['user-agent'] ?? '';
  return {
    ip: {
      hash: storeIp === 'hashed' ? saltedHash(req.ip, hashSalt) : null,
      raw: storeIp === 'raw' ? req.ip : null,
    },
    ua: {
      hash: storeUserAgent === 'hashed' && uaRaw ? saltedHash(uaRaw, hashSalt) : null,
      raw: storeUserAgent === 'raw' ? uaRaw : null,
    },
  };
}

function toSnake(b: PlaybackSessionResponse) {
  return {
    session_id: b.sessionId,
    token: b.token,
    manifest_url: b.manifestUrl,
    expires_at: b.expiresAt,
    token_expires_at: b.tokenExpiresAt,
    refresh_after: b.refreshAfter,
    watermark: b.watermark && {
      enabled: b.watermark.enabled,
      text: b.watermark.text,
      position: b.watermark.position,
      interval_seconds: b.watermark.intervalSeconds,
      opacity: b.watermark.opacity,
      font_size_vh: b.watermark.fontSizeVh,
      tiled: b.watermark.tiled,
    },
  };
}
