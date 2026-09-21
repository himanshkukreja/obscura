import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import {
  ErrorCodes, ObscuraError, notFound, formatSessionId, AssetStatus,
} from '@obscura/shared';
import { assertScope } from '@obscura/auth';
import { StorageKeys } from '@obscura/storage';
import { rewritePlaylist } from '@obscura/media';
import { authorizeStateless, authorizeStateful } from './session.ts';
import type { Deps } from './deps.ts';

const MAX_KEY_FETCHES_PER_TOKEN = 40;

export function registerStreamRoutes(app: FastifyInstance, deps: Deps): void {
  // ── master playlist ──────────────────────────────────────────────────────
  app.get('/stream/:sid/master.m3u8', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { t } = req.query as { t?: string };
    const { session, claims } = await authorizeStateful(deps, sid, t);
    assertScope(claims, 'manifest');

    const asset = await deps.repos.assets.byId(session.asset_id);
    if (!asset || asset.status !== AssetStatus.READY) throw notFound('Asset is not available');

    const stored = await readText(deps, asset.delivery_bucket!, StorageKeys.master(asset.id));
    // Rewrite variant URIs to session-scoped manifest endpoints. The stored master stays
    // identical for every viewer.
    const out = stored.replace(
      /^(?!#)(.+\/playlist\.m3u8)$/gm,
      (_m, uri: string) => {
        const rendition = uri.split('/')[0]!;
        const kind = rendition === 'subs' ? 'subs' : 'v';
        return `${deps.cfg.edge.publicUrl}/stream/${sid}/${kind === 'subs' ? uri.replace(/^subs\//, 'subs/').replace(/\/playlist\.m3u8$/, '') : rendition}/playlist.m3u8?t=${encodeURIComponent(t!)}`;
      },
    ).replace(
      /URI="(subs\/[^"]+\/playlist\.m3u8)"/g,
      (_m, uri: string) => {
        const lang = uri.split('/')[1]!;
        return `URI="${deps.cfg.edge.publicUrl}/stream/${sid}/subs/${lang}/playlist.m3u8?t=${encodeURIComponent(t!)}"`;
      },
    );

    await deps.repos.sessions.event(session.id, session.asset_id, 'manifest', { kind: 'master' });
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'private, max-age=10');
    return out;
  });

  // ── variant playlist ─────────────────────────────────────────────────────
  app.get('/stream/:sid/:rendition/playlist.m3u8', async (req, reply) => {
    const { sid, rendition } = req.params as { sid: string; rendition: string };
    const { t } = req.query as { t?: string };
    const { session, claims } = await authorizeStateful(deps, sid, t);
    assertScope(claims, 'manifest');

    const asset = await deps.repos.assets.byId(session.asset_id);
    if (!asset) throw notFound('Asset not found');
    const rows = await deps.repos.renditions.forAsset(asset.id);
    if (!rows.some((r) => r.name === rendition)) throw notFound(`Rendition ${rendition} not found`);

    const bucket = asset.delivery_bucket!;
    const stored = await readText(deps, bucket, StorageKeys.playlist(asset.id, rendition));
    const ext = deps.cfg.packaging.container === 'fmp4' ? 'm4s' : 'ts';

    const ctx = {
      sessionId: sid, token: t!, edgePublicUrl: deps.cfg.edge.publicUrl, bucket,
    };

    // Resolve each segment URI through the active delivery strategy. This is the only
    // place that knows whether bytes come from us, from storage, or from a CDN.
    const uris = new Map<string, string>();
    const parsedLines = stored.split(/\r?\n/);
    for (const line of parsedLines) {
      if (line && !line.startsWith('#')) {
        const idx = Number(/seg_(\d{5})\./.exec(line)?.[1] ?? 0);
        uris.set(line, await deps.delivery.segmentUrl({
          assetId: asset.id, rendition, filename: line,
          storageKey: StorageKeys.segment(asset.id, rendition, idx, ext),
        }, ctx));
      }
    }
    const initUrl = await deps.delivery.segmentUrl({
      assetId: asset.id, rendition, filename: 'init.mp4',
      storageKey: StorageKeys.init(asset.id, rendition),
    }, ctx);

    const out = rewritePlaylist(stored, {
      segmentUri: (uri) => uris.get(uri) ?? uri,
      initUri: () => initUrl,
      keyUri: `${deps.cfg.edge.publicUrl}/stream/${sid}/key/${keyIdFor(await deps.repos.contentKeys.forAsset(asset.id))}?t=${encodeURIComponent(t!)}`,
    });

    await deps.repos.sessions.event(session.id, session.asset_id, 'manifest', { rendition });
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'private, max-age=10');
    return out;
  });

  // ── subtitle playlist ────────────────────────────────────────────────────
  app.get('/stream/:sid/subs/:lang/playlist.m3u8', async (req, reply) => {
    const { sid, lang } = req.params as { sid: string; lang: string };
    const { t } = req.query as { t?: string };
    const { session, claims } = await authorizeStateful(deps, sid, t);
    assertScope(claims, 'manifest');

    const asset = await deps.repos.assets.byId(session.asset_id);
    if (!asset) throw notFound('Asset not found');
    const stored = await readText(deps, asset.delivery_bucket!, StorageKeys.subPlaylist(asset.id, lang));

    const out = rewritePlaylist(stored, {
      segmentUri: (uri) =>
        `${deps.cfg.edge.publicUrl}/stream/${sid}/subs/${lang}/${uri}?t=${encodeURIComponent(t!)}`,
    });
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    reply.header('Cache-Control', 'private, max-age=10');
    return out;
  });

  app.get('/stream/:sid/subs/:lang/:file', async (req, reply) => {
    const { sid, lang, file } = req.params as { sid: string; lang: string; file: string };
    const { t } = req.query as { t?: string };
    const { session } = await authorizeStateful(deps, sid, t);
    const asset = await deps.repos.assets.byId(session.asset_id);
    if (!asset) throw notFound('Asset not found');
    if (!/^seg_\d{5}\.vtt$/.test(file)) throw notFound('Not found');

    const key = `${StorageKeys.subsPrefix(asset.id)}${lang}/${file}`;
    const got = await deps.storage.get(asset.delivery_bucket!, key);
    reply.header('Content-Type', 'text/vtt');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(got.body);
  });

  // ── content key: the revocation choke point ──────────────────────────────
  app.get('/stream/:sid/key/:kid', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { sid, kid } = req.params as { sid: string; kid: string };
    const { t } = req.query as { t?: string };

    // Always stateful. This is the one request a player cannot cache, so it is where
    // revocation takes effect immediately even though segments validate statelessly.
    const { session, claims } = await authorizeStateful(deps, sid, t);
    assertScope(claims, 'key');

    if (!/^[0-9a-f]{32}$/.test(kid)) throw notFound('Unknown key');
    const row = await deps.repos.contentKeys.byKid(Buffer.from(kid, 'hex'));
    if (!row || row.asset_id !== session.asset_id) {
      await deps.repos.sessions.event(session.id, session.asset_id, 'denied', { reason: 'wrong_key' });
      throw notFound('Unknown key');
    }

    // Bounded replay tracking: a player needs a handful of fetches, a scraper needs many.
    const uses = await deps.repos.sessions.recordTokenUse(
      claims.jti, session.id, new Date(claims.exp * 1000),
    );
    if (uses > MAX_KEY_FETCHES_PER_TOKEN) {
      await deps.repos.sessions.event(session.id, session.asset_id, 'anomaly', {
        reason: 'key_replay', uses,
      });
      throw new ObscuraError(ErrorCodes.RATE_LIMITED, 'Too many key fetches for this token', {
        status: 429,
      });
    }

    const key = await deps.keys.unwrap(
      { kid: row.kid, ciphertext: row.key_ciphertext, nonce: row.key_nonce,
        tag: row.key_tag, provider: row.provider },
      { assetId: session.asset_id, kid: row.kid },
    );

    await deps.repos.sessions.event(session.id, session.asset_id, 'key', {});
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    return reply.send(key);
  });

  // ── proxy segment delivery (proxy strategy only) ─────────────────────────
  app.get('/stream/:sid/seg/:rendition/:file', async (req, reply) => {
    const { sid, rendition, file } = req.params as { sid: string; rendition: string; file: string };
    const { t } = req.query as { t?: string };

    // Stateless on purpose: this is the hot path, and it is the request that a CDN edge
    // would validate in production.
    const { sessionId, claims } = authorizeStateless(deps, sid, t);
    assertScope(claims, 'segment');

    if (!/^(seg_\d{5}\.(m4s|ts)|init\.mp4)$/.test(file)) throw notFound('Not found');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(rendition)) throw notFound('Not found');

    const asset = await deps.repos.assets.byId(claims.aid);
    if (!asset || !asset.delivery_bucket) throw notFound('Asset not found');

    const key = file === 'init.mp4'
      ? StorageKeys.init(asset.id, rendition)
      : `${StorageKeys.renditionPrefix(asset.id, rendition)}${file}`;

    const range = parseRange(req.headers.range);
    const got = await deps.storage.get(asset.delivery_bucket, key, range ?? undefined);

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', got.contentType ?? 'application/octet-stream');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    if (got.contentLength !== null) reply.header('Content-Length', String(got.contentLength));
    if (range && got.contentRange) {
      reply.header('Content-Range', got.contentRange);
      reply.status(206);
    }
    void sessionId;
    return reply.send(Readable.from(got.body));
  });
}

function keyIdFor(keys: { kid: Buffer }[]): string {
  const k = keys[0];
  if (!k) throw new ObscuraError(ErrorCodes.INTERNAL, 'Asset has no content key');
  return k.kid.toString('hex');
}

function parseRange(header: string | undefined): { start: number; end?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : undefined;
  return end === undefined ? { start } : { start, end };
}

async function readText(deps: Deps, bucket: string, key: string): Promise<string> {
  const got = await deps.storage.get(bucket, key);
  const chunks: Buffer[] = [];
  for await (const c of got.body) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export { formatSessionId };
