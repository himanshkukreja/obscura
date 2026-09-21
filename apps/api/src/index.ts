import { migrate, ensurePartitions } from '@obscura/db';
import { buildApp } from './app.ts';
import { createDeps } from './deps.ts';
import { registerAssetRoutes } from './routes/assets.ts';
import { registerPlaybackRoutes } from './routes/playback.ts';
import { registerDeletionRoutes } from './routes/deletion.ts';
import { registerIntegrityRoutes } from './routes/integrity.ts';
import { registerSubtitleRoutes } from './routes/subtitles.ts';
import { registerOpsRoutes } from './routes/ops.ts';

const deps = createDeps();
const app = await buildApp(deps);

registerAssetRoutes(app, deps);
registerPlaybackRoutes(app, deps);
registerDeletionRoutes(app, deps);
registerIntegrityRoutes(app, deps);
registerSubtitleRoutes(app, deps);
registerOpsRoutes(app, deps);

if (process.env['API_RUN_MIGRATIONS'] !== 'false') {
  const applied = await migrate(deps.db);
  if (applied.length) app.log.info({ applied }, 'migrations applied');
  await ensurePartitions(deps.db);
}

await app.listen({ host: deps.cfg.api.host, port: deps.cfg.api.port });
app.log.info(
  { port: deps.cfg.api.port, delivery: deps.delivery.name, env: deps.cfg.env },
  'obscura api started',
);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void (async () => {
      await app.close();
      await deps.close();
      process.exit(0);
    })();
  });
}
