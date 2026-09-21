-- Obscura initial schema.
-- PostgreSQL holds state and decisions; object storage holds artifacts and bulk data.

CREATE TABLE IF NOT EXISTS api_clients (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  key_prefix    text NOT NULL UNIQUE,
  key_hash      text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  auth_mode     text NOT NULL DEFAULT 'api_key',
  auth_config   jsonb NOT NULL DEFAULT '{}',
  policy        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE IF NOT EXISTS assets (
  id                  uuid PRIMARY KEY,
  client_id           uuid NOT NULL REFERENCES api_clients(id),
  external_ref        text,
  title               text,
  status              text NOT NULL,
  status_reason       text,
  error_code          text,
  retryable           boolean,

  original_filename   text,
  content_type        text,
  source_bucket       text NOT NULL,
  source_key          text NOT NULL,
  source_size         bigint,
  source_sha256       bytea,

  probe               jsonb,
  probe_sha256        bytea,
  duration_ms         integer,
  width               integer,
  height              integer,

  pipeline_version    text,
  ladder              jsonb,
  ladder_config_sha256 text,

  delivery_bucket     text,
  integrity_key       text,
  asset_root          bytea,
  integrity_signature text,
  integrity_key_id    text,

  expires_at          timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  ready_at            timestamptz,
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_client_external_ref
  ON assets (client_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_client_status ON assets (client_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS assets_source_sha256 ON assets (source_sha256) WHERE source_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_expiry ON assets (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS content_keys (
  id              uuid PRIMARY KEY,
  asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kid             bytea NOT NULL UNIQUE,
  key_ciphertext  bytea NOT NULL,
  key_nonce       bytea NOT NULL,
  key_tag         bytea NOT NULL,
  provider        text NOT NULL,
  rotation_index  integer NOT NULL DEFAULT 0,
  iv              bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_keys_asset ON content_keys (asset_id);

CREATE TABLE IF NOT EXISTS renditions (
  id                  uuid PRIMARY KEY,
  asset_id            uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  name                text NOT NULL,
  status              text NOT NULL,
  width               integer,
  height              integer,
  video_bitrate       text,
  audio_bitrate       text,
  segment_count       integer,
  segment_duration_ms integer,
  duration_ms         integer,
  bytes_total         bigint,
  playlist_key        text,
  playlist_sha256     bytea,
  init_sha256         bytea,
  merkle_root         bytea,
  content_key_id      uuid REFERENCES content_keys(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (asset_id, name)
);

CREATE TABLE IF NOT EXISTS subtitle_tracks (
  id            uuid PRIMARY KEY,
  asset_id      uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  language      text NOT NULL,
  label         text,
  kind          text NOT NULL DEFAULT 'subtitles',
  is_default    boolean NOT NULL DEFAULT false,
  origin        text NOT NULL DEFAULT 'upload',
  playlist_key  text,
  playlist_sha256 bytea,
  merkle_root   bytea,
  cue_count     integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, language, kind)
);

CREATE TABLE IF NOT EXISTS jobs (
  id               uuid PRIMARY KEY,
  asset_id         uuid REFERENCES assets(id) ON DELETE CASCADE,
  type             text NOT NULL,
  target           text,
  state            text NOT NULL,
  attempt          integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  progress         numeric(5,2),
  idempotency_key  text NOT NULL UNIQUE,
  queue_ref        text,
  lease_expires_at timestamptz,
  error_code       text,
  error_detail     text,
  retryable        boolean,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_asset ON jobs (asset_id, type, state);
CREATE INDEX IF NOT EXISTS jobs_running ON jobs (state, lease_expires_at) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS playback_sessions (
  id                 bytea PRIMARY KEY,
  asset_id           uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  client_id          uuid NOT NULL REFERENCES api_clients(id),
  subject_ref        text NOT NULL,
  subject_label      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  revoke_reason      text,
  delivery_strategy  text NOT NULL,
  token_epoch        integer NOT NULL DEFAULT 0,
  client_binding     bytea,
  ip_hash            bytea,
  user_agent_hash    bytea,
  ip_raw             inet,
  user_agent_raw     text,
  watermark_text     text
);
CREATE INDEX IF NOT EXISTS sessions_subject ON playback_sessions (client_id, subject_ref, expires_at DESC);
CREATE INDEX IF NOT EXISTS sessions_asset ON playback_sessions (asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_active ON playback_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS session_events (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  session_id  bytea NOT NULL,
  asset_id    uuid,
  type        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL,
  actor_id     text,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  meta         jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

-- Retained indefinitely and deliberately excluded from retention configuration:
-- a policy that erases proof-of-erasure defeats its own purpose.
-- No FK to assets: the asset row is gone by the time this is the only record left.
CREATE TABLE IF NOT EXISTS deletion_records (
  asset_id                uuid PRIMARY KEY,
  client_id               uuid,
  source_sha256           bytea,
  asset_root              bytea,
  reason                  text NOT NULL,
  requested_by            text,
  requested_at            timestamptz NOT NULL,
  completed_at            timestamptz,
  objects_deleted         integer NOT NULL DEFAULT 0,
  storage_verified_empty  boolean NOT NULL DEFAULT false,
  content_keys_destroyed  integer NOT NULL DEFAULT 0,
  cdn_invalidation        jsonb,
  sessions_revoked        integer NOT NULL DEFAULT 0,
  record                  jsonb,
  signature               text,
  signing_key_id          text
);

CREATE TABLE IF NOT EXISTS token_replay (
  jti        text PRIMARY KEY,
  session_id bytea NOT NULL,
  uses       integer NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS token_replay_expiry ON token_replay (expires_at);
