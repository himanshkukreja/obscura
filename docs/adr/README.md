# Architecture decision records

Immutable, numbered records of significant decisions. Superseded rather than edited.
Format: Context / Decision / Alternatives considered / Consequences — see
[ADR-0001](0001-record-architecture-decisions.md).

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-language-and-runtime.md) | TypeScript on Node.js for API, worker and CLI | Accepted |
| [0003](0003-hls-cmaf-over-dash.md) | HLS with CMAF/fMP4 segments; DASH deferred | Accepted |
| [0004](0004-encryption-aes128-not-drm.md) | AES-128 HLS encryption in v1; no DRM in the core | Accepted |
| [0005](0005-delivery-and-authorization.md) | URL-bound tokens, per-session manifests, pluggable delivery | Accepted |
| [0006](0006-watermarking-strategy.md) | ~~Overlay and burn-in in v1; A/B variant reserved~~ | **Superseded by 0012** |
| [0007](0007-integrity-merkle-signed-manifest.md) | Merkle trees over segments, signed with Ed25519 | Accepted |
| [0008](0008-job-queue.md) | BullMQ on Redis, PostgreSQL as authoritative job record | Accepted |
| [0009](0009-storage-abstraction.md) | S3 API behind a narrow port, two buckets | Accepted |
| [0010](0010-repository-structure.md) | pnpm monorepo, separated control and data plane | Accepted |
| [0011](0011-verified-deletion.md) | Deletion is a verified, attested pipeline | Accepted |
| [0012](0012-watermarking-overlay-only.md) | Overlay watermarking only; burn-in and A/B cut | Accepted |
| [0013](0013-encrypt-after-packaging.md) | Apply AES-128 after packaging, not via FFmpeg | Accepted |
| [0014](0014-content-key-created-once.md) | Content key created in `process`, never lazily | Accepted |
