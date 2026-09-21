import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
export type { PoolClient } from 'pg';

// bytea -> Buffer is the default; make numeric/bigint predictable too.
pg.types.setTypeParser(20, (v) => Number(v));   // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

export interface Db {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string, params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
  tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

export function createDb(url: string, max = 10): Db {
  const pool = new Pool({ connectionString: url, max });
  return {
    pool,
    query: (text, params) => pool.query(text, params as never[]),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    const { rowCount } = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
    if (rowCount) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    await db.tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

/** Keep a rolling window of monthly partitions ahead of now. */
export async function ensurePartitions(db: Db, monthsAhead = 2): Promise<void> {
  for (const base of ['session_events', 'audit_log']) {
    for (let i = 0; i <= monthsAhead; i++) {
      await db.query(
        `SELECT obscura_ensure_partition($1, (date_trunc('month', now()) + ($2 || ' month')::interval)::date)`,
        [base, String(i)],
      );
    }
  }
}
