import type { Db } from '../pool.ts';
import type { DeliveryStrategyName } from '@obscura/shared';

export interface SessionRow {
  id: Buffer;
  asset_id: string;
  client_id: string;
  subject_ref: string;
  subject_label: string | null;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  delivery_strategy: DeliveryStrategyName;
  token_epoch: number;
  client_binding: Buffer | null;
  watermark_text: string | null;
}

export type SessionEventType =
  | 'created' | 'manifest' | 'key' | 'segment' | 'heartbeat'
  | 'expired' | 'revoked' | 'denied' | 'anomaly';

export class SessionRepository {
  constructor(private readonly db: Db) {}

  async create(s: {
    id: Buffer; assetId: string; clientId: string; subjectRef: string;
    subjectLabel: string | null; expiresAt: Date; deliveryStrategy: DeliveryStrategyName;
    clientBinding: Buffer | null; ipHash: Buffer | null; userAgentHash: Buffer | null;
    ipRaw: string | null; userAgentRaw: string | null; watermarkText: string | null;
  }): Promise<SessionRow> {
    const { rows } = await this.db.query<SessionRow>(
      `INSERT INTO playback_sessions
         (id, asset_id, client_id, subject_ref, subject_label, expires_at, delivery_strategy,
          client_binding, ip_hash, user_agent_hash, ip_raw, user_agent_raw, watermark_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [s.id, s.assetId, s.clientId, s.subjectRef, s.subjectLabel, s.expiresAt,
       s.deliveryStrategy, s.clientBinding, s.ipHash, s.userAgentHash, s.ipRaw,
       s.userAgentRaw, s.watermarkText],
    );
    return rows[0]!;
  }

  async byId(id: Buffer): Promise<SessionRow | null> {
    const { rows } = await this.db.query<SessionRow>(
      'SELECT * FROM playback_sessions WHERE id = $1', [id],
    );
    return rows[0] ?? null;
  }

  async countActive(clientId: string, subjectRef: string, now = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM playback_sessions
        WHERE client_id = $1 AND subject_ref = $2 AND revoked_at IS NULL AND expires_at > $3`,
      [clientId, subjectRef, now],
    );
    return rows[0]?.n ?? 0;
  }

  async touch(id: Buffer): Promise<void> {
    await this.db.query('UPDATE playback_sessions SET last_seen_at = now() WHERE id = $1', [id]);
  }

  async revoke(id: Buffer, reason: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE playback_sessions SET revoked_at = now(), revoke_reason = $2,
         token_epoch = token_epoch + 1
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeAllForAsset(assetId: string, reason: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE playback_sessions SET revoked_at = now(), revoke_reason = $2,
         token_epoch = token_epoch + 1
       WHERE asset_id = $1 AND revoked_at IS NULL`,
      [assetId, reason],
    );
    return rowCount ?? 0;
  }

  async revokeAllForSubject(clientId: string, subjectRef: string, reason: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE playback_sessions SET revoked_at = now(), revoke_reason = $3,
         token_epoch = token_epoch + 1
       WHERE client_id = $1 AND subject_ref = $2 AND revoked_at IS NULL`,
      [clientId, subjectRef, reason],
    );
    return rowCount ?? 0;
  }

  async event(sessionId: Buffer, assetId: string | null, type: SessionEventType, meta: Record<string, unknown> = {}): Promise<void> {
    // Never let an audit write break playback.
    await this.db.query(
      'INSERT INTO session_events (session_id, asset_id, type, meta) VALUES ($1,$2,$3,$4)',
      [sessionId, assetId, type, JSON.stringify(meta)],
    ).catch(() => {});
  }

  /** Who viewed this asset, and roughly how long. Duration is estimated from heartbeat and
   *  key-fetch counts: precise position tracking would be behavioural profiling. */
  async accessLog(assetId: string, opts: { from?: Date; to?: Date; limit: number; cursor?: string }) {
    const params: unknown[] = [assetId];
    const where = ['s.asset_id = $1'];
    if (opts.from) { params.push(opts.from); where.push(`s.created_at >= $${params.length}`); }
    if (opts.to) { params.push(opts.to); where.push(`s.created_at <= $${params.length}`); }
    if (opts.cursor) { params.push(new Date(opts.cursor)); where.push(`s.created_at < $${params.length}`); }
    params.push(opts.limit + 1);
    const { rows } = await this.db.query<{
      id: Buffer; subject_ref: string; created_at: Date; last_seen_at: Date | null;
      revoked_at: Date | null; manifest: number; key: number; heartbeat: number;
    }>(
      `SELECT s.id, s.subject_ref, s.created_at, s.last_seen_at, s.revoked_at,
              count(*) FILTER (WHERE e.type = 'manifest')::int AS manifest,
              count(*) FILTER (WHERE e.type = 'key')::int AS key,
              count(*) FILTER (WHERE e.type = 'heartbeat')::int AS heartbeat
         FROM playback_sessions s
         LEFT JOIN session_events e ON e.session_id = s.id
        WHERE ${where.join(' AND ')}
        GROUP BY s.id, s.subject_ref, s.created_at, s.last_seen_at, s.revoked_at
        ORDER BY s.created_at DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > opts.limit;
    const data = hasMore ? rows.slice(0, opts.limit) : rows;
    return { data, nextCursor: hasMore ? (data.at(-1)?.created_at.toISOString() ?? null) : null };
  }

  /** Bounded replay tracking on the key endpoint. */
  async recordTokenUse(jti: string, sessionId: Buffer, expiresAt: Date): Promise<number> {
    const { rows } = await this.db.query<{ uses: number }>(
      `INSERT INTO token_replay (jti, session_id, expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (jti) DO UPDATE SET uses = token_replay.uses + 1
       RETURNING uses`,
      [jti, sessionId, expiresAt],
    );
    return rows[0]?.uses ?? 1;
  }

  async purgeExpiredReplay(): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM token_replay WHERE expires_at < now()');
    return rowCount ?? 0;
  }
}
