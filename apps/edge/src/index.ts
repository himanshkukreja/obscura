import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ObscuraError, ErrorCodes, PINO_REDACT_PATHS, uuidv7 } from '@obscura/shared';
import { createDeps } from './deps.ts';
import { registerStreamRoutes } from './routes.ts';

const deps = createDeps();

const app = Fastify({
  logger: {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
  },
  genReqId: () => uuidv7(),
  trustProxy: true,
});

// Strict allowlist: the key endpoint in particular must not be reachable cross-origin
// from anywhere the operator has not named.
await app.register(cors, {
  origin: deps.cfg.playback.corsOrigins,
  methods: ['GET', 'HEAD', 'OPTIONS'],
});
await app.register(rateLimit, {
  max: 1200, timeWindow: '1 minute',
  keyGenerator: (req) => (req.params as { sid?: string })?.sid ?? req.ip,
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ObscuraError) {
    return reply.status(err.status).send({ error: err.toJSON(), request_id: req.id });
  }
  if ((err as { statusCode?: number }).statusCode === 429) {
    return reply.status(429).send({
      error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests' }, request_id: req.id,
    });
  }
  req.log.error({ err }, 'unhandled edge error');
  return reply.status(500).send({
    error: { code: ErrorCodes.INTERNAL, message: 'Internal error' }, request_id: req.id,
  });
});

registerStreamRoutes(app, deps);
app.get('/healthz', async () => ({ ok: true }));

await app.listen({ host: deps.cfg.edge.host, port: deps.cfg.edge.port });
app.log.info(
  { port: deps.cfg.edge.port, delivery: deps.delivery.name, proxiesBytes: deps.delivery.proxiesBytes },
  'obscura edge started',
);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void (async () => { await app.close(); await deps.close(); process.exit(0); })();
  });
}
