import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ObscuraError, ErrorCodes, PINO_REDACT_PATHS, uuidv7, badRequest } from '@obscura/shared';
import { authenticate, type ApiClientRow } from './deps.ts';
import type { Deps } from './deps.ts';

declare module 'fastify' {
  interface FastifyRequest { client?: ApiClientRow }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
    },
    genReqId: () => uuidv7(),
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024,
  });

  /**
   * Many HTTP clients set `Content-Type: application/json` on a bodyless POST. Fastify's
   * default parser rejects that outright, which turns a perfectly ordinary request into a
   * 500. Treat an empty body as `{}` and let per-route schemas decide what is required.
   */
  // Brand-logo upload sends raw PNG bytes. Without this Fastify tries to JSON-parse them
  // and the request fails before the route is reached.
  app.addContentTypeParser(
    ['image/png', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, {});
    try { done(null, JSON.parse(text)); }
    catch (e) { done(badRequest(`Malformed JSON body: ${(e as Error).message}`), undefined); }
  });

  await app.register(cors, { origin: deps.cfg.playback.corsOrigins });
  await app.register(rateLimit, {
    max: 600, timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization?.slice(-24) ?? req.ip,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ObscuraError) {
      if (err.status >= 500) req.log.error({ code: err.code, detail: err.detail }, err.message);
      return reply.status(err.status).send({ error: err.toJSON(), request_id: req.id });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests' },
        request_id: req.id,
      });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({
        error: { code: ErrorCodes.INVALID_REQUEST, message: (err as Error).message },
        request_id: req.id,
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: ErrorCodes.INTERNAL, message: 'Internal error' },
      request_id: req.id,
    });
  });

  // A malformed id must be a 404, not a database error surfacing as a 500.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.addHook('preValidation', async (req) => {
    const id = (req.params as { id?: string } | undefined)?.id;
    if (id !== undefined && !UUID.test(id)) {
      throw new ObscuraError(ErrorCodes.NOT_FOUND, 'Not found', { status: 404 });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Request-Id', reply.request.id);
    return payload;
  });

  return app;
}

/** Authenticate the calling application. Obscura never authenticates your end users. */
export async function requireClient(deps: Deps, req: FastifyRequest): Promise<ApiClientRow> {
  if (!req.client) {
    req.client = await authenticate(deps.repos.clients, req.headers.authorization);
  }
  return req.client;
}
