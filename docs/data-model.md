# Data model

PostgreSQL 16+. Plain SQL with versioned migration files; no ORM schema reflection.

## Design principles

1. **PostgreSQL holds state and decisions; object storage holds artifacts and bulk data.**
   Per-segment hashes go in `integrity.json`, not in a table — see
   [integrity.md §4](integrity.md#4-the-integrity-manifest).
2. **Append-only event tables are time-partitioned**, so retention is a partition drop
   rather than a long-running `DELETE`.
3. **Secrets are never stored in plaintext.** API keys are Argon2id hashes; content keys
   are AEAD-wrapped ciphertext.
4. **Identifiers are UUIDv7** — time-ordered, so they index well without leaking a
   sequential count. Session IDs are the exception: 256 bits of CSPRNG output, because a
   session ID is a capability and must not be guessable or ordered.

---

## Core tables

```sql
-- ─── Integration ────────────────────────────────────────────────────────────

CREATE TABLE api_clients (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  key_prefix    text NOT NULL UNIQUE,      -- clear, for O(1) lookup + log correlation
  key_hash      text NOT NULL,             -- Argon2id of the secret
  scopes        text[] NOT NULL DEFAULT '{}',
  auth_mode     text NOT NULL,             -- api_key | jwt | callback
  auth_config   jsonb NOT NULL DEFAULT '{}',  -- JWKS url, callback url, timeouts
  policy        jsonb NOT NULL DEFAULT '{}',  -- session ttl, concurrency, watermark defaults
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE signing_keys (
  id            uuid PRIMARY KEY,
  key_id        text NOT NULL UNIQUE,      -- e.g. 'obscura-integrity-2026-01'
  purpose       text NOT NULL,             -- integrity | playback_token
  algorithm     text NOT NULL,             -- Ed25519
  public_key    bytea NOT NULL,
  private_ref   text NOT NULL,             -- KeyProvider reference, NEVER the key itself
  status        text NOT NULL,             -- active | retiring | retired
  not_before    timestamptz NOT NULL,
  not_after     timestamptz
);

-- ─── Assets ─────────────────────────────────────────────────────────────────

CREATE TABLE assets (
  id                  uuid PRIMARY KEY,
  client_id           uuid NOT NULL REFERENCES api_clients(id),
  external_ref        text,                -- your application's own id
  title               text,
  status              text NOT NULL,       -- see lifecycle below
  status_reason       text,
  error_code          text,
  retryable           boolean,

  original_filename   text,             -- suppressible at ingest: filenames leak
                                         -- personal data (privacy.md §3)
  content_type        text,
  source_bucket       text NOT NULL,
  source_key          text NOT NULL,
  source_size         bigint,
  source_sha256       bytea,               -- 32 bytes; NULL until hashed

  probe               jsonb,               -- full ffprobe output
  duration_ms         integer,
  width               integer,
  height              integer,

  pipeline_version    text,
  ladder              jsonb,               -- resolved ladder actually used
  watermark_policy    jsonb,

  delivery_bucket     text,
  hls_prefix          text,
  integrity_key       text,                -- storage key of integrity.json
  asset_root          bytea,               -- Merkle root over the whole asset
  integrity_signature bytea,
  integrity_key_id    text REFERENCES signing_keys(key_id),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  ready_at            timestamptz,
  deleted_at          timestamptz,

  UNIQUE (client_id, external_ref)
);
CREATE INDEX ON assets (client_id, status, created_at DESC);
CREATE INDEX ON assets (source_sha256) WHERE source_sha256 IS NOT NULL;  -- dedupe

CREATE TABLE renditions (
  id                uuid PRIMARY KEY,
  asset_id          uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  name              text NOT NULL,         -- '1080p'
  status            text NOT NULL,         -- pending | running | complete | failed
  width             integer, height integer,
  fps_num           integer, fps_den integer,
  video_codec       text, audio_codec text,
  video_bitrate     integer, audio_bitrate integer,
  segment_count     integer,
  segment_duration_ms integer,
  duration_ms       integer,
  bytes_total       bigint,
  playlist_key      text,
  playlist_sha256   bytea,
  init_sha256       bytea,
  merkle_root       bytea,                 -- root only; leaves live in integrity.json
  content_key_id    uuid REFERENCES content_keys(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  UNIQUE (asset_id, name)
);

CREATE TABLE subtitle_tracks (
  id            uuid PRIMARY KEY,
  asset_id      uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  language      text NOT NULL,             -- BCP-47
  label         text,
  kind          text NOT NULL DEFAULT 'subtitles',  -- subtitles | captions
  is_default    boolean NOT NULL DEFAULT false,
  origin        text NOT NULL DEFAULT 'upload',     -- upload | transcript_import
  source_key    text,
  playlist_key  text,
  merkle_root   bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, language, kind)
);

-- ─── Jobs ───────────────────────────────────────────────────────────────────
-- PostgreSQL is the authoritative record of job state; Redis/BullMQ is the dispatcher.

CREATE TABLE jobs (
  id               uuid PRIMARY KEY,
  asset_id         uuid REFERENCES assets(id) ON DELETE CASCADE,
  type             text NOT NULL,          -- probe | hash | transcode | finalize | delete | verify
  target           text,                   -- rendition name, when applicable
  state            text NOT NULL,          -- queued | running | succeeded | failed | cancelled
  attempt          integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  progress         numeric(5,2),
  idempotency_key  text NOT NULL UNIQUE,   -- (asset_id, type, target, pipeline_version)
  queue_ref        text,
  lease_expires_at timestamptz,
  error_code       text,
  error_detail     text,                   -- includes ffmpeg stderr; operator-scoped only
  retryable        boolean,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX ON jobs (asset_id, type, state);
CREATE INDEX ON jobs (state, lease_expires_at) WHERE state = 'running';  -- stall sweeper

-- ─── Keys ───────────────────────────────────────────────────────────────────

CREATE TABLE content_keys (
  id              uuid PRIMARY KEY,
  asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kid             bytea NOT NULL UNIQUE,   -- 16 bytes, public identifier
  key_ciphertext  bytea NOT NULL,          -- AES-256-GCM wrapped; NEVER plaintext
  key_nonce       bytea NOT NULL,
  key_tag         bytea NOT NULL,
  provider        text NOT NULL,           -- envelope | aws_kms | vault
  provider_ref    text,
  rotation_index  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

-- ─── Playback ───────────────────────────────────────────────────────────────

CREATE TABLE playback_sessions (
  id                 bytea PRIMARY KEY,    -- 32 bytes CSPRNG, NOT a uuid
  asset_id           uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  client_id          uuid NOT NULL REFERENCES api_clients(id),
  subject_ref        text NOT NULL,        -- opaque; supplied by the host application
  subject_label      text,                 -- optional display string for the watermark

  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  revoke_reason      text,

  delivery_strategy  text NOT NULL,        -- proxy | presigned | cdn_signed
  token_epoch        integer NOT NULL DEFAULT 0,  -- bump to invalidate issued tokens
  client_binding     bytea,                -- hash of the player-held binding value

  ip_hash            bytea,                -- salted; NULL when privacy.store_ip = none
  user_agent_hash    bytea,
  ip_raw             inet,                 -- only when explicitly configured
  user_agent_raw     text,

  watermark_text     text                  -- rendered overlay string; overlay-only,
                                           -- so no separate assignment table (ADR-0012)
);
CREATE INDEX ON playback_sessions (client_id, subject_ref, expires_at DESC);
CREATE INDEX ON playback_sessions (asset_id, created_at DESC);
CREATE INDEX ON playback_sessions (expires_at) WHERE revoked_at IS NULL;  -- reaper

CREATE TABLE deletion_records (
  asset_id                uuid PRIMARY KEY,   -- no FK: the asset row may be gone
  source_sha256           bytea,              -- one-way; not personal data
  asset_root              bytea,
  reason                  text NOT NULL,      -- data_subject_request | retention
                                              -- | operator | client_request
  requested_by            text,
  requested_at            timestamptz NOT NULL,
  completed_at            timestamptz,
  objects_deleted         integer,
  storage_verified_empty  boolean,
  content_keys_destroyed  integer,
  cdn_invalidation        jsonb,
  sessions_revoked        integer,
  signature               bytea,
  signing_key_id          text
);
-- Retained indefinitely. Holds no personal data by construction: a SHA-256 cannot
-- reconstruct or identify the video. See privacy.md §4.

-- ─── Events and audit (partitioned monthly) ─────────────────────────────────

CREATE TABLE session_events (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  session_id  bytea NOT NULL,
  type        text NOT NULL,     -- created | manifest | key | heartbeat | expired
                                 -- | revoked | denied | anomaly
  at          timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}'  -- never tokens, never key material
) PARTITION BY RANGE (at);

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL,    -- api_client | operator | system
  actor_id     text,
  action       text NOT NULL,    -- asset.created | asset.deleted | session.revoked
                                 -- | key.rotated | client.disabled
  target_type  text, target_id text,
  meta         jsonb NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (at);
```

## Asset lifecycle

```
UPLOADING ─▶ UPLOADED ─▶ VALIDATING ─▶ PROCESSING ─▶ PACKAGING ─▶ ENCRYPTING ─▶ READY
     │           │            │             │             │            │
     └───────────┴────────────┴─────────────┴─────────────┴────────────┴──▶ FAILED
                                                                  READY ──▶ DELETING ─▶ DELETED
```

Transitions happen only in a transaction that also records the driving job. `READY`
requires: every rendition `complete`, `integrity.json` written and its signature verified,
and a `HEAD` on every object the manifest claims exists.

## Deliberate omissions

| Not modelled | Why |
|---|---|
| Users, passwords, roles, org hierarchies | Your application owns identity. We store an opaque `subject_ref` and nothing more. |
| Per-segment rows | ~7,200 rows per 2-hour asset, written once and read together. They belong in `integrity.json`. |
| View counts, watch time, analytics | A different product. We emit events; aggregate them elsewhere. |
| Comments, playlists, categories, thumbnails-as-content | Platform features, not delivery primitives. |
| Soft-delete on every table | Only `assets` needs it, for the `DELETING → DELETED` reconciliation. |
| Per-viewer media derivatives | Burn-in watermarking was cut ([ADR-0012](adr/0012-watermarking-overlay-only.md)). One canonical rendition set means one thing to secure, audit and destroy. |
| Precise playback telemetry | Watch time is estimated from heartbeat and key-fetch counts. Exact position tracking is behavioural profiling and contradicts [privacy.md §3](privacy.md#3-minimisation-by-design). |

## Retention

A scheduled job drops partitions past their window and hard-deletes expired rows:

```yaml
retention:
  playback_sessions_days: 90
  session_events_days: 30
  audit_log_days: 365
  failed_jobs_days: 30
  asset_default_ttl_days: null    # null = keep until explicitly deleted
```

`deletion_records` is deliberately absent from this list. It is retained **indefinitely**
and is not configurable: it is the evidence that a deletion happened, it holds no personal
data by construction, and a retention policy that erases proof-of-erasure defeats its own
purpose. Everything else is enforced by a scheduled job — partition drops for the event
tables, hard deletes elsewhere. See [privacy.md](privacy.md).
