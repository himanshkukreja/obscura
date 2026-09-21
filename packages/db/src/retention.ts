import type { Db } from './pool.ts';

export interface RetentionConfig {
  playbackSessionsDays: number;
  sessionEventsDays: number;
  auditLogDays: number;
  failedJobsDays: number;
}

export interface RetentionResult {
  partitionsDropped: string[];
  sessionsDeleted: number;
  jobsDeleted: number;
  replayPurged: number;
}

/**
 * Retention that depends on someone remembering to run something is not retention.
 * Event tables are partitioned so this is a partition DROP, not a long-running DELETE.
 *
 * deletion_records is deliberately absent: it is the evidence that a deletion happened,
 * holds no personal data by construction, and erasing proof-of-erasure defeats itself.
 */
export async function enforceRetention(db: Db, cfg: RetentionConfig): Promise<RetentionResult> {
  const partitionsDropped: string[] = [];

  for (const [base, days] of [
    ['session_events', cfg.sessionEventsDays],
    ['audit_log', cfg.auditLogDays],
  ] as const) {
    const { rows } = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = $1`,
      [base],
    );
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const cutoffKey = `${cutoff.getUTCFullYear()}${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const r of rows) {
      const suffix = r.relname.slice(base.length + 1);
      if (/^\d{6}$/.test(suffix) && suffix < cutoffKey) {
        await db.query(`DROP TABLE IF EXISTS ${r.relname}`);
        partitionsDropped.push(r.relname);
      }
    }
  }

  const sessions = await db.query(
    `DELETE FROM playback_sessions WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(cfg.playbackSessionsDays)],
  );
  const jobs = await db.query(
    `DELETE FROM jobs WHERE state IN ('succeeded','failed')
       AND finished_at < now() - ($1 || ' days')::interval`,
    [String(cfg.failedJobsDays)],
  );
  const replay = await db.query('DELETE FROM token_replay WHERE expires_at < now()');

  return {
    partitionsDropped,
    sessionsDeleted: sessions.rowCount ?? 0,
    jobsDeleted: jobs.rowCount ?? 0,
    replayPurged: replay.rowCount ?? 0,
  };
}
