import { loadConfig } from '@obscura/shared';
import { createDb, migrate, ensurePartitions } from './pool.ts';

const cfg = loadConfig();
const db = createDb(cfg.database.url, 2);
try {
  const applied = await migrate(db);
  await ensurePartitions(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema already up to date');
} finally {
  await db.close();
}
