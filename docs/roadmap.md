# MVP and roadmap

Scoped for **one person building it**. The rule throughout: a working vertical slice beats
a large amount of unfinished infrastructure. Every phase ends with something demonstrable,
tested and documented.

---

## Phase 0 — Research and architecture *(complete)*

This documentation set. No production code.

✅ stack chosen with reasons · ✅ threat model written · ✅ encryption options compared ·
✅ licence exposure assessed · ✅ privacy and deletion designed · ✅ MVP scoped.

---

## Phase 1 — Prove the pipeline *(~1 week)*

```
MP4 → FFmpeg → HLS/CMAF → MinIO → hls.js
```

No encryption, no auth, no watermarking. Public bucket. Prove the media path is correct
before building anything on top of it.

Deliverables: monorepo scaffold · `StorageProvider` + S3 implementation · ffprobe wrapper ·
ladder selection · FFmpeg HLS packaging · minimal player · Docker Compose.

**Exit:** `docker compose up`, upload a video, watch it play with working quality
switching. A test asserts **identical segment-boundary PTS across renditions**
([architecture.md](architecture.md#keyframe-alignment-is-not-optional)). Without that test,
Phase 1 is not done.

**Do first, before building the pipeline out:** run the empirical compatibility matrix in
[research.md §7](research.md#7-open-questions-to-settle-empirically-in-phase-1). It can
invalidate the container and encryption choices, and finding that out now is cheap.

---

## Phase 2 — Private storage and authorized playback *(~1.5 weeks)*

Deliverables: PostgreSQL schema and migrations · BullMQ worker with resumable job
decomposition · asset lifecycle · API-key authentication · playback sessions and signed
tokens · session-scoped manifest generation · `proxy` and `presigned` delivery · heartbeat
and revocation · **access log endpoint**.

**Exit:** every bucket is private, the browser plays the video, and the source object is
unreachable from any URL the browser sees. A revoked session stops working. A test asserts
no response body or header anywhere contains the source object key.

JWT and callback authorization providers are deferred — API keys cover the first
deployment and the port is already defined.

---

## Phase 3 — Encryption *(~1 week)*

Deliverables: `KeyProvider` with envelope encryption · AES-128 packaging via
`-hls_key_info_file` · session-scoped key endpoint with database checks, `no-store`,
strict CORS and rate limiting.

**Exit:** segments fetched directly from storage are undecryptable. Playback works through
hls.js. Revoking a session denies the next key fetch immediately. A test greps a full
playback run's logs for key material and fails on any match.

Key rotation within an asset is deferred — one key per asset is sufficient and is what
Phase 4's crypto-shredding depends on.

---

## Phase 4 — Deletion and retention *(~1 week)*

**This phase is the differentiator.** No comparable open-source project implements it.

Deliverables: verified purge job (list storage rather than trusting the database,
batch-delete, destroy content keys, invalidate CDN, purge identifying columns, **re-list
and assert empty**) · signed deletion records · retention enforcement job with partition
drops · `store_ip` / `store_user_agent` / `store_original_filename` privacy settings ·
per-asset TTL.

**Exit:** `DELETE /assets/{id}` leaves zero objects in storage, a destroyed key, and a
signed record proving it. A test seeds an orphaned object from a simulated failed job and
asserts the purge finds it anyway. A test asserts segments remain undecryptable after key
destruction. See [privacy.md §4](privacy.md#4-verified-deletion).

---

## Phase 5 — Integrity *(~1 week)*

Deliverables: streaming source hashing fused with download · per-artifact hashes · Merkle
trees with domain separation · RFC 8785 canonicalization · Ed25519 signing ·
`integrity.json` · verify API, proof endpoint, published public keys · `obscura verify`.

**Exit:** `obscura verify <asset-id>` passes on a clean asset and fails with a precise diff
after one byte is flipped in storage. The CLI distinguishes "not ours", "modified version
of ours", and "cannot say" — the honesty requirement in
[integrity.md §2](integrity.md#2-what-a-hash-does-not-prove).

---

## Phase 6 — Subtitles and player polish *(~0.5 week)*

Deliverables: WebVTT subtitle renditions · SRT conversion · **transcript import endpoint**
· overlay watermark in the player · quality selector, playback speed, fullscreen ·
graceful session-expiry handling.

Subtitles are cheap here and disproportionately valuable: any platform producing these
recordings usually already has a transcript, so `POST /assets/{id}/subtitles` accepting
timed text turns existing data into a feature. Viewers skim transcripts more than they
watch video.

---

## MVP = Phases 1–6

**In:**

- Upload to S3/R2/MinIO; probe, validate, hash.
- Ladder selection that never upscales, tuned for the talking-head profile.
- FFmpeg → HLS/CMAF with correct keyframe alignment.
- AES-128 encryption with envelope-wrapped keys.
- Private buckets; the source is never browser-addressable.
- Playback sessions: short-lived tokens, heartbeat, revocation, concurrency limits.
- Session-scoped manifests; `proxy` and `presigned` delivery.
- **Verified deletion with signed records and cryptographic erasure.**
- Retention enforcement and privacy settings.
- Access log per asset.
- Signed integrity manifests with Merkle proofs and verification.
- WebVTT subtitles, including transcript import.
- Reference React + hls.js player with overlay watermarking.
- `obscura` CLI: `upload`, `process`, `inspect`, `verify`, `delete`.
- `docker compose up` works with no cloud account.
- Tests across storage, processing, security, deletion, integrity and playback.

**Out:**

DASH · DRM · burned-in or A/B watermarking · live streaming · CDN signing · Kubernetes ·
a web admin UI · multi-tenancy beyond API clients · analytics · KMS providers · JWT and
callback authorization.

---

## Phase 7 — Production hardening *(post-MVP, driven by real use)*

CDN delivery strategy — **only once measurement justifies it.** With a handful of viewers
per asset, cache hit ratios are low and `presigned` against S3 may be sufficient
indefinitely; build the CloudFront signer when the egress bill says to, not before.

Also here: JWT and callback authorization providers · KMS and Vault key providers ·
OpenTelemetry and Prometheus · anomaly signals · pg-boss `JobQueue` for Postgres-only
deployments · scheduled re-verification · load testing with published numbers.

## Phase 8 — Open-source release

`LICENSE` (Apache-2.0) · `SECURITY.md` · `CONTRIBUTING.md` including the
**no-FFmpeg-linking** rule and the licence policy · `CODE_OF_CONDUCT.md` ·
`docs/third-party.md` · CI: lint, typecheck, unit, integration, e2e, licence check, secret
scanning, container scanning · release automation with signed artifacts and an SBOM ·
integration examples for S3, R2 and MinIO · a demo deployment.

Sequenced after real production use, per the decision to prove it internally first.

## Post-1.0 candidates

| Item | Rationale |
|---|---|
| DASH manifest generation | Nearly free — the CMAF segments already exist |
| `cbcs` CENC packaging + EME ClearKey | Makes a later DRM migration a key-management change, not a re-encode |
| Thumbnails, sprite sheets, I-frame playlists | Ordinary player expectations |
| Hardware-accelerated transcoding | Cost, once profiling justifies it |
| Screen-share / mixed-content encoding profile | If recordings include coding exercises or screen capture, that content wants different tuning from talking heads |
| C2PA alignment | If provenance ever needs to be interoperable rather than internal |

## Permanent non-goals

Live streaming · a user management platform · a media CMS · proprietary DRM in the core ·
analytics or behavioural telemetry · burned-in or A/B watermarking
([ADR-0012](adr/0012-watermarking-overlay-only.md)) · anything that turns this into "a
giant video platform."
