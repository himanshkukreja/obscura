import type { Db } from '../pool.ts';
import { AssetStatus, type ProbeResult, type ResolvedRendition } from '@obscura/shared';

export interface AssetRow {
  id: string;
  client_id: string;
  external_ref: string | null;
  title: string | null;
  status: AssetStatus;
  status_reason: string | null;
  error_code: string | null;
  retryable: boolean | null;
  original_filename: string | null;
  content_type: string | null;
  source_bucket: string;
  source_key: string;
  source_size: number | null;
  source_sha256: Buffer | null;
  probe: ProbeResult | null;
  probe_sha256: Buffer | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  pipeline_version: string | null;
  ladder: ResolvedRendition[] | null;
  ladder_config_sha256: string | null;
  delivery_bucket: string | null;
  integrity_key: string | null;
  asset_root: Buffer | null;
  integrity_signature: string | null;
  integrity_key_id: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
  deleted_at: Date | null;
}

export class AssetRepository {
  constructor(private readonly db: Db) {}

  async create(a: {
    id: string; clientId: string; externalRef: string | null; title: string | null;
    originalFilename: string | null; contentType: string | null;
    sourceBucket: string; sourceKey: string; sourceSize: number | null;
    deliveryBucket: string; expiresAt: Date | null;
  }): Promise<AssetRow> {
    const { rows } = await this.db.query<AssetRow>(
      `INSERT INTO assets (id, client_id, external_ref, title, status, original_filename,
                           content_type, source_bucket, source_key, source_size,
                           delivery_bucket, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [a.id, a.clientId, a.externalRef, a.title, AssetStatus.UPLOADING, a.originalFilename,
       a.contentType, a.sourceBucket, a.sourceKey, a.sourceSize, a.deliveryBucket, a.expiresAt],
    );
    return rows[0]!;
  }

  async byId(id: string): Promise<AssetRow | null> {
    const { rows } = await this.db.query<AssetRow>('SELECT * FROM assets WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async byIdForClient(id: string, clientId: string): Promise<AssetRow | null> {
    const { rows } = await this.db.query<AssetRow>(
      'SELECT * FROM assets WHERE id = $1 AND client_id = $2', [id, clientId],
    );
    return rows[0] ?? null;
  }

  async list(clientId: string, opts: { status?: string; externalRef?: string; cursor?: string; limit: number }) {
    const where: string[] = ['client_id = $1'];
    const params: unknown[] = [clientId];
    if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
    if (opts.externalRef) { params.push(opts.externalRef); where.push(`external_ref = $${params.length}`); }
    if (opts.cursor) { params.push(opts.cursor); where.push(`id < $${params.length}`); }
    params.push(opts.limit + 1);
    const { rows } = await this.db.query<AssetRow>(
      `SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > opts.limit;
    const data = hasMore ? rows.slice(0, opts.limit) : rows;
    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
  }

  async setStatus(
    id: string, status: AssetStatus,
    extra: { reason?: string | null; errorCode?: string | null; retryable?: boolean | null } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE assets SET status = $2, status_reason = $3, error_code = $4, retryable = $5,
         updated_at = now(), ready_at = CASE WHEN $2 = 'READY' THEN now() ELSE ready_at END
       WHERE id = $1`,
      [id, status, extra.reason ?? null, extra.errorCode ?? null, extra.retryable ?? null],
    );
  }

  async setProbe(id: string, p: ProbeResult, probeSha256: Buffer): Promise<void> {
    await this.db.query(
      `UPDATE assets SET probe = $2, probe_sha256 = $3, duration_ms = $4, width = $5,
         height = $6, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(p), probeSha256, p.durationMs, p.displayWidth, p.displayHeight],
    );
  }

  async setSourceHash(id: string, sha256: Buffer, size: number): Promise<void> {
    await this.db.query(
      'UPDATE assets SET source_sha256 = $2, source_size = $3, updated_at = now() WHERE id = $1',
      [id, sha256, size],
    );
  }

  async setLadder(id: string, ladder: ResolvedRendition[], hash: string, pipelineVersion: string): Promise<void> {
    await this.db.query(
      `UPDATE assets SET ladder = $2, ladder_config_sha256 = $3, pipeline_version = $4,
         updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(ladder), hash, pipelineVersion],
    );
  }

  async setIntegrity(id: string, a: {
    integrityKey: string; assetRoot: Buffer; signature: string; keyId: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE assets SET integrity_key = $2, asset_root = $3, integrity_signature = $4,
         integrity_key_id = $5, updated_at = now() WHERE id = $1`,
      [id, a.integrityKey, a.assetRoot, a.signature, a.keyId],
    );
  }

  /** Deletion: drop everything identifying while keeping one-way hashes and timestamps. */
  async redactForDeletion(id: string): Promise<void> {
    await this.db.query(
      `UPDATE assets SET original_filename = NULL, probe = NULL, title = NULL,
         status = 'DELETED', deleted_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    await this.db.query(
      `UPDATE playback_sessions SET subject_ref = 'redacted', subject_label = NULL,
         watermark_text = NULL, ip_raw = NULL, user_agent_raw = NULL, ip_hash = NULL,
         user_agent_hash = NULL WHERE asset_id = $1`,
      [id],
    );
  }

  async dueForRetention(now = new Date()): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM assets
        WHERE expires_at IS NOT NULL AND expires_at <= $1
          AND status NOT IN ('DELETING','DELETED') LIMIT 200`,
      [now],
    );
    return rows.map((r) => r.id);
  }
}
