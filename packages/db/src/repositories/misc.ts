import type { Db } from '../pool.ts';
import type { AssetStatus, DeletionRecord, ResolvedRendition } from '@obscura/shared';

// ── API clients ─────────────────────────────────────────────────────────────

export interface ApiClientRow {
  id: string; name: string; key_prefix: string; key_hash: string;
  scopes: string[]; auth_mode: string; auth_config: Record<string, unknown>;
  policy: Record<string, unknown>; created_at: Date; disabled_at: Date | null;
}

export class ApiClientRepository {
  constructor(private readonly db: Db) {}

  async create(c: { id: string; name: string; keyPrefix: string; keyHash: string; scopes: string[] }) {
    const { rows } = await this.db.query<ApiClientRow>(
      `INSERT INTO api_clients (id, name, key_prefix, key_hash, scopes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [c.id, c.name, c.keyPrefix, c.keyHash, c.scopes],
    );
    return rows[0]!;
  }

  async byPrefix(prefix: string): Promise<ApiClientRow | null> {
    const { rows } = await this.db.query<ApiClientRow>(
      'SELECT * FROM api_clients WHERE key_prefix = $1 AND disabled_at IS NULL', [prefix],
    );
    return rows[0] ?? null;
  }
}

// ── Content keys ────────────────────────────────────────────────────────────

export interface ContentKeyRow {
  id: string; asset_id: string; kid: Buffer;
  key_ciphertext: Buffer; key_nonce: Buffer; key_tag: Buffer;
  provider: string; rotation_index: number; iv: Buffer;
}

export class ContentKeyRepository {
  constructor(private readonly db: Db) {}

  async create(k: {
    id: string; assetId: string; kid: Buffer; ciphertext: Buffer; nonce: Buffer;
    tag: Buffer; provider: string; iv: Buffer;
  }): Promise<ContentKeyRow> {
    const { rows } = await this.db.query<ContentKeyRow>(
      `INSERT INTO content_keys (id, asset_id, kid, key_ciphertext, key_nonce, key_tag, provider, iv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [k.id, k.assetId, k.kid, k.ciphertext, k.nonce, k.tag, k.provider, k.iv],
    );
    return rows[0]!;
  }

  async byKid(kid: Buffer): Promise<ContentKeyRow | null> {
    const { rows } = await this.db.query<ContentKeyRow>(
      'SELECT * FROM content_keys WHERE kid = $1', [kid],
    );
    return rows[0] ?? null;
  }

  async forAsset(assetId: string): Promise<ContentKeyRow[]> {
    const { rows } = await this.db.query<ContentKeyRow>(
      'SELECT * FROM content_keys WHERE asset_id = $1 ORDER BY rotation_index', [assetId],
    );
    return rows;
  }

  /**
   * DESTROY, not revoke. A revoked-flag leaves the material in the database; deleting the
   * row is what makes every surviving copy of a segment permanently unreadable.
   */
  async destroyForAsset(assetId: string): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM content_keys WHERE asset_id = $1', [assetId]);
    return rowCount ?? 0;
  }
}

// ── Renditions ──────────────────────────────────────────────────────────────

export interface RenditionRow {
  id: string; asset_id: string; name: string; status: string;
  width: number | null; height: number | null;
  video_bitrate: string | null; audio_bitrate: string | null;
  segment_count: number | null; segment_duration_ms: number | null;
  duration_ms: number | null; bytes_total: number | null;
  playlist_key: string | null; playlist_sha256: Buffer | null;
  init_sha256: Buffer | null; merkle_root: Buffer | null;
  content_key_id: string | null; completed_at: Date | null;
}

export class RenditionRepository {
  constructor(private readonly db: Db) {}

  async upsertPending(id: string, assetId: string, r: ResolvedRendition): Promise<void> {
    await this.db.query(
      `INSERT INTO renditions (id, asset_id, name, status, width, height, video_bitrate, audio_bitrate)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7)
       ON CONFLICT (asset_id, name) DO UPDATE SET
         width = EXCLUDED.width, height = EXCLUDED.height,
         video_bitrate = EXCLUDED.video_bitrate, audio_bitrate = EXCLUDED.audio_bitrate`,
      [id, assetId, r.name, r.width, r.height, r.videoBitrate, r.audioBitrate],
    );
  }

  async setStatus(assetId: string, name: string, status: string): Promise<void> {
    await this.db.query(
      'UPDATE renditions SET status = $3 WHERE asset_id = $1 AND name = $2',
      [assetId, name, status],
    );
  }

  async complete(assetId: string, name: string, d: {
    segmentCount: number; segmentDurationMs: number; durationMs: number; bytesTotal: number;
    playlistKey: string; playlistSha256: Buffer; initSha256: Buffer | null;
    merkleRoot: Buffer; contentKeyId: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE renditions SET status='complete', segment_count=$3, segment_duration_ms=$4,
         duration_ms=$5, bytes_total=$6, playlist_key=$7, playlist_sha256=$8,
         init_sha256=$9, merkle_root=$10, content_key_id=$11, completed_at=now()
       WHERE asset_id=$1 AND name=$2`,
      [assetId, name, d.segmentCount, d.segmentDurationMs, d.durationMs, d.bytesTotal,
       d.playlistKey, d.playlistSha256, d.initSha256, d.merkleRoot, d.contentKeyId],
    );
  }

  async forAsset(assetId: string): Promise<RenditionRow[]> {
    const { rows } = await this.db.query<RenditionRow>(
      'SELECT * FROM renditions WHERE asset_id = $1 ORDER BY height DESC NULLS LAST', [assetId],
    );
    return rows;
  }
}

// ── Subtitles ───────────────────────────────────────────────────────────────

export interface SubtitleRow {
  id: string; asset_id: string; language: string; label: string | null;
  kind: string; is_default: boolean; origin: string;
  playlist_key: string | null; playlist_sha256: Buffer | null;
  merkle_root: Buffer | null; cue_count: number | null;
}

export class SubtitleRepository {
  constructor(private readonly db: Db) {}

  async upsert(s: {
    id: string; assetId: string; language: string; label: string | null;
    isDefault: boolean; origin: string; playlistKey: string; playlistSha256: Buffer;
    merkleRoot: Buffer; cueCount: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO subtitle_tracks (id, asset_id, language, label, is_default, origin,
                                    playlist_key, playlist_sha256, merkle_root, cue_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (asset_id, language, kind) DO UPDATE SET
         label = EXCLUDED.label, is_default = EXCLUDED.is_default, origin = EXCLUDED.origin,
         playlist_key = EXCLUDED.playlist_key, playlist_sha256 = EXCLUDED.playlist_sha256,
         merkle_root = EXCLUDED.merkle_root, cue_count = EXCLUDED.cue_count`,
      [s.id, s.assetId, s.language, s.label, s.isDefault, s.origin, s.playlistKey,
       s.playlistSha256, s.merkleRoot, s.cueCount],
    );
  }

  async forAsset(assetId: string): Promise<SubtitleRow[]> {
    const { rows } = await this.db.query<SubtitleRow>(
      'SELECT * FROM subtitle_tracks WHERE asset_id = $1 ORDER BY language', [assetId],
    );
    return rows;
  }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export class JobRepository {
  constructor(private readonly db: Db) {}

  async upsert(j: {
    id: string; assetId: string; type: string; target: string | null; idempotencyKey: string;
  }): Promise<{ id: string; state: string; created: boolean }> {
    const { rows } = await this.db.query<{ id: string; state: string }>(
      `INSERT INTO jobs (id, asset_id, type, target, state, idempotency_key)
       VALUES ($1,$2,$3,$4,'queued',$5)
       ON CONFLICT (idempotency_key) DO UPDATE SET state =
         CASE WHEN jobs.state = 'failed' THEN 'queued' ELSE jobs.state END
       RETURNING id, state`,
      [j.id, j.assetId, j.type, j.target, j.idempotencyKey],
    );
    return { ...rows[0]!, created: rows[0]!.id === j.id };
  }

  async start(id: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET state='running', attempt = attempt + 1, started_at = now(),
         lease_expires_at = now() + interval '30 minutes' WHERE id = $1`, [id],
    );
  }

  async progress(id: string, fraction: number): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET progress = $2, lease_expires_at = now() + interval '30 minutes' WHERE id = $1`,
      [id, Math.round(fraction * 10000) / 100],
    );
  }

  async succeed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET state='succeeded', progress=100, finished_at=now(),
         lease_expires_at=NULL WHERE id = $1`, [id],
    );
  }

  async fail(id: string, code: string, detail: string, retryable: boolean): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET state='failed', error_code=$2, error_detail=$3, retryable=$4,
         finished_at=now(), lease_expires_at=NULL WHERE id = $1`,
      [id, code, detail.slice(0, 20000), retryable],
    );
  }

  async forAsset(assetId: string) {
    const { rows } = await this.db.query<{
      id: string; type: string; target: string | null; state: string;
      progress: number | null; error_code: string | null; retryable: boolean | null;
      attempt: number; error_detail: string | null;
    }>('SELECT * FROM jobs WHERE asset_id = $1 ORDER BY created_at', [assetId]);
    return rows;
  }
}

// ── Deletion records ────────────────────────────────────────────────────────

export class DeletionRepository {
  constructor(private readonly db: Db) {}

  async open(d: {
    assetId: string; clientId: string; sourceSha256: Buffer | null; assetRoot: Buffer | null;
    reason: string; requestedBy: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO deletion_records
         (asset_id, client_id, source_sha256, asset_root, reason, requested_by, requested_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (asset_id) DO NOTHING`,
      [d.assetId, d.clientId, d.sourceSha256, d.assetRoot, d.reason, d.requestedBy],
    );
  }

  async complete(assetId: string, record: DeletionRecord): Promise<void> {
    await this.db.query(
      `UPDATE deletion_records SET completed_at = $2, objects_deleted = $3,
         storage_verified_empty = $4, content_keys_destroyed = $5, cdn_invalidation = $6,
         sessions_revoked = $7, record = $8, signature = $9, signing_key_id = $10
       WHERE asset_id = $1`,
      [assetId, record.completedAt, record.objectsDeleted, record.storageVerifiedEmpty,
       record.contentKeysDestroyed, JSON.stringify(record.cdnInvalidation),
       record.sessionsRevoked, JSON.stringify(record), record.signature?.value ?? null,
       record.signature?.keyId ?? null],
    );
  }

  /** Answers after the asset row is gone - that is the point of it. */
  async byAssetId(assetId: string): Promise<DeletionRecord | null> {
    const { rows } = await this.db.query<{ record: DeletionRecord | null }>(
      'SELECT record FROM deletion_records WHERE asset_id = $1', [assetId],
    );
    return rows[0]?.record ?? null;
  }

  async exists(assetId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('SELECT 1 FROM deletion_records WHERE asset_id = $1', [assetId]);
    return (rowCount ?? 0) > 0;
  }
}

export class AuditRepository {
  constructor(private readonly db: Db) {}
  async log(a: {
    actorType: string; actorId: string | null; action: string;
    targetType?: string | null; targetId?: string | null; meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.actorType, a.actorId, a.action, a.targetType ?? null, a.targetId ?? null,
       JSON.stringify(a.meta ?? {})],
    ).catch(() => {});
  }
}

export type { AssetStatus };
