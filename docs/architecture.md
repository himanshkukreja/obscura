# Architecture

## 1. Recommended technology stack

**Decision: TypeScript on Node.js 22 LTS, Fastify for HTTP, BullMQ/Redis for jobs,
PostgreSQL for state, FFmpeg as a subprocess, React + hls.js for the reference player.**

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | One language across API, worker, CLI and player. The wire contracts (session response, integrity manifest, ladder config) become a single shared `packages/shared` type package consumed by the browser player — a real, non-cosmetic benefit for a project whose correctness lives in those contracts. |
| HTTP | Fastify 5 | Fastest mainstream Node framework; schema-first (JSON Schema) request/response validation, which doubles as generated OpenAPI; first-class `pino` logging with redaction (we must never log tokens or keys). |
| Jobs | BullMQ + Redis | Transcodes run for minutes to hours. BullMQ gives job progress, stalled-job detection via lock renewal, per-step retry and concurrency control — the semantics that actually matter for long jobs. |
| Database | PostgreSQL 16+ | Transactional asset/session state, `jsonb` for probe output, partitioned event tables for audit retention. |
| Media | FFmpeg 7+/8 and FFprobe, invoked as subprocesses | Never link FFmpeg into our process. Subprocess isolation gives us crash containment, per-job CPU limits, clean cancellation, and it keeps FFmpeg's GPL licensing at arm's length (see [research.md](research.md#6-license-analysis)). |
| Storage | S3 API via `@aws-sdk/client-s3` | Works unchanged against S3, R2 and MinIO, behind our own `StorageProvider` port. |
| Player | React + TypeScript + hls.js | hls.js (Apache-2.0) is the only mature browser HLS client with a custom-loader API we need for tokenized key/segment fetching. |
| Packaging | Docker + Docker Compose | Compose is the developer experience. Kubernetes is a deployment target, not a dependency. |

### Why not Python + FastAPI

FastAPI is an excellent alternative and the gap is small. The decisive factors:

- **Shared types with the player.** The player is unavoidably TypeScript. With Node, the
  playback-session contract, the integrity manifest schema and the watermark policy
  schema are defined once and type-checked on both sides. With Python they are defined
  twice (or generated, which is a build-system tax on every contributor).
- **The workload is I/O orchestration, not computation.** All CPU work is inside FFmpeg.
  Python's numerical advantage is irrelevant here, and the GIL/async-ergonomics
  discussion is moot for a process that mostly awaits S3 and subprocesses.
- **Contributor surface.** A single-language monorepo is materially easier to contribute
  to, which matters for an open-source project.

**Tradeoff we are accepting:** the strongest open-source invisible-watermarking and
perceptual-hashing libraries are PyTorch (notably Meta's VideoSeal, MIT). When we reach
Phase 6 we will want them.

**Mitigation, designed in from day one:** the worker is already a separate process that
communicates only through the queue and object storage. A future `apps/watermark-worker`
can be Python, consume the same BullMQ queue (BullMQ has a Python client) or a
Postgres-backed queue, and never touch the TypeScript codebase. The language boundary is
placed at a seam that already exists. This is recorded in
[ADR-0002](adr/0002-language-and-runtime.md).

### Deliberately excluded

Kubernetes-by-default, Kafka, Elasticsearch, a service mesh, GraphQL, an ORM with
migrations-by-reflection. None have a requirement behind them. Database access uses
plain SQL via a thin query layer plus versioned migration files.

---

## 2. High-level architecture

Five deployable units and four backing services:

```
┌──────────────────────────────────────────────────────────────────────┐
│  apps/api          stateless  │  control plane                       │
│    · asset CRUD, upload targets, process triggers                    │
│    · playback session mint / heartbeat / revoke                      │
│    · integrity manifests and Merkle proofs                           │
│    · no media bytes                                                  │
├──────────────────────────────────────────────────────────────────────┤
│  apps/edge         stateless  │  data plane (co-deployable with api) │
│    · session-scoped manifest generation (m3u8 rewriting)             │
│    · content-key endpoint                                            │
│    · optional byte proxy (Range) for the `proxy` delivery strategy   │
├──────────────────────────────────────────────────────────────────────┤
│  apps/worker       stateful   │  processing plane                    │
│    · probe, validate, hash, transcode, package, encrypt, upload      │
├──────────────────────────────────────────────────────────────────────┤
│  apps/player       static     │  reference React player              │
│  apps/cli          local      │  obscura                              │
└──────────────────────────────────────────────────────────────────────┘
        PostgreSQL          Redis          Object storage          CDN
```

`api` and `edge` are separate route trees in one codebase, deployable as one container
for small installs and as two for production. They are split because their scaling
characteristics and network exposure differ: `edge` is request-heavy, latency-sensitive
and must be reachable by the browser; `api` is low-volume and can sit behind stricter
network policy.

### Internal ports (the parts that are swappable)

Everything named here is an interface in `packages/*` with at least one implementation in
v1 and a documented path to more. These are the project's extension points.

| Port | v1 implementation | Designed-for alternatives |
|---|---|---|
| `StorageProvider` | S3 API (S3 / R2 / MinIO) | GCS, Azure Blob, filesystem |
| `KeyProvider` | Envelope encryption: DB-stored keys wrapped by a master key from env | AWS KMS, GCP KMS, Vault, HSM |
| `JobQueue` | BullMQ / Redis | pg-boss (Postgres-only deployments), SQS |
| `AuthorizationProvider` | Static API key, JWT (JWKS), HTTP callback | OIDC introspection, mTLS |
| `DeliveryStrategy` | `proxy`, `presigned`, `cdn-signed` | Per-CDN signers (CloudFront, Cloudflare, Fastly, Akamai) |
| `WatermarkProvider` | `overlay` (client-side) | Reserved only; burn-in and A/B were cut ([ADR-0012](adr/0012-watermarking-overlay-only.md)) |
| `IntegritySigner` | Ed25519, local key | KMS-backed signing, C2PA |

---

## 3. Detailed request / playback flow

### 3.1 Ingest

```
Your app                      API                        Storage         Queue
   │                           │                            │              │
   ├─ POST /assets ───────────▶│ create row, status=UPLOADING              │
   │  {filename, size, sha256?}│                            │              │
   │◀── {asset_id, upload} ────┤ presigned PUT or multipart │              │
   │                           │                            │              │
   ├─ PUT bytes ──────────────────────────────────────────▶ │  (direct;    │
   │                           │                            │   never via  │
   │                           │                            │   the API)   │
   ├─ POST /assets/{id}/commit ▶ HEAD object, verify size,   │              │
   │                           │ status=UPLOADED ───────────┼─ enqueue ───▶│
   │◀── 202 {status} ──────────┤                            │              │
```

The uploader talks to storage directly with a narrowly scoped, short-lived presigned
PUT. The API never carries upload bytes. `commit` is the trust boundary: nothing is
processed until the API has independently `HEAD`ed the object.

### 3.2 Playback

```
Browser            Your app             API              Edge          CDN/Storage
   │                   │                 │                │                │
   ├ "play asset X" ──▶│                 │                │                │
   │                   │ ── your authorization decision ──│                │
   │                   ├ POST /assets/X/playback-session ▶│                │
   │                   │   Authorization: <api credential>│                │
   │                   │   {subject_ref, ttl, watermark}  │                │
   │                   │◀─ {session_id, token,            │                │
   │                   │    manifest_url, expires_at,     │                │
   │◀─ session ────────┤    refresh_after}                │                │
   │                                                      │                │
   ├ GET master.m3u8?t=<token> ─────────────────────────▶ │ validate token │
   │◀── session-scoped master playlist ────────────────── │ rewrite URIs   │
   │                                                      │                │
   ├ GET <rendition>/playlist.m3u8?t=<token> ───────────▶ │ inject         │
   │◀── media playlist with #EXT-X-KEY → key endpoint ─── │ EXT-X-KEY      │
   │                                                      │                │
   ├ GET /key/{kid}?t=<token> ──────────────────────────▶ │ session live?  │
   │◀── 16 raw key bytes (Cache-Control: no-store) ────── │ not revoked?   │
   │                                                      │                │
   ├ GET segment ───────────────────────────────────────────────────────▶ │
   │◀── encrypted segment bytes (cacheable) ───────────────────────────── │
   │                                                                       │
   ├ POST /playback/{sid}/heartbeat ─▶ refreshed token, or 401 if revoked  │
```

Four things are worth noticing:

1. **The token is in the query string, not a header.** This is forced by native HLS on
   Apple platforms, which offers no way to add request headers. A URL-bound token is the
   only mechanism that works across hls.js, native HLS, and CDN edge validation. See
   [security-model.md](security-model.md#why-tokens-live-in-urls).
2. **Manifests are generated per session, not stored per session.** A manifest is ~2 KB.
   Generating it lets us rewrite segment URIs for whichever delivery strategy is active
   and point `#EXT-X-KEY` at a session-scoped key endpoint, without ever storing
   per-user artifacts. The API is a *manifest authority*, not a byte proxy.
3. **The key endpoint is the revocation choke point.** It is the one request the player
   cannot avoid making and cannot cache (`Cache-Control: no-store`). Session revocation
   takes effect at the next key fetch, which is why key rotation interval is a
   security-relevant tunable, not just a hygiene setting.
4. **Segment bytes are encrypted and identical for every viewer**, so they are fully
   CDN-cacheable and there is exactly one copy of the media to secure, audit and destroy.
   Preserving that property is why per-viewer burned-in watermarking was cut
   ([ADR-0012](adr/0012-watermarking-overlay-only.md)): scattering per-viewer derivatives
   of personal data makes deletion strictly harder for a benefit this deployment profile
   never realises.

---

## 4. Processing pipeline

```
 UPLOADED
    │
    ├─▶ [1] probe        ffprobe -show_streams -show_format -print_format json
    │                    → duration, w, h, fps, codecs, bitrate, pix_fmt,
    │                      channels, sample rate, rotation, colour primaries/
    │                      transfer/matrix (HDR detection)
    │
    ├─▶ [2] validate     reject: no video stream · duration 0 or > max ·
    │                    unsupported codec · pixel format we cannot handle ·
    │                    probe/metadata mismatch with declared content type
    │                    → FAILED(VALIDATION_FAILED, retryable=false)
    │
    ├─▶ [3] hash         streaming SHA-256 of source bytes, fused with the
    │                    download so the object is read exactly once
    │
    ├─▶ [4] ladder       choose renditions (§5). Never upscale. Cap at source
    │                    height and at ~source bitrate. Always at least one rung.
    │
    ├─▶ [5] transcode    one FFmpeg invocation per rendition, resumable and
    │                    idempotent per rendition (see §"Failure handling")
    │
    ├─▶ [6] package      fMP4/CMAF segments + media playlist per rendition,
    │                    master playlist, subtitle renditions
    │
    ├─▶ [7] encrypt      AES-128 with a per-asset content key from KeyProvider,
    │                    optional rotation every N segments
    │
    ├─▶ [8] integrity    SHA-256 every segment, playlist and init segment;
    │                    Merkle tree per rendition; asset root; Ed25519 signature
    │
    ├─▶ [9] upload       renditions + integrity.json + asset.json, then a final
    │                    consistency check (HEAD every key we claim to have written)
    │
    └─▶ READY            only after [9] verifies. Never earlier.
```

### Keyframe alignment is not optional

For ABR switching to work, **every rendition must have an IDR frame at the same
presentation timestamps**. FFmpeg will not do this by accident. Each rendition must be
encoded with an explicit forced-keyframe expression pinned to the segment duration:

```
-force_key_frames "expr:gte(t, n_forced * <segment_seconds>)"
```

combined with a GOP no longer than the segment and scene-cut keyframe insertion disabled,
so the encoder cannot insert an unplanned IDR that desynchronises the ladder. Getting
this wrong produces a stream that plays fine in testing and stutters on quality switches
in production. It is called out here because it is the single most commonly botched
detail in FFmpeg-based HLS pipelines, and it must be covered by an automated test that
asserts identical segment boundary PTS across renditions.

### Transcode decisions

- **v1 always re-encodes.** Stream copy (`-c:v copy`) is tempting when the source already
  matches a rung, but it cannot guarantee the keyframe alignment above. Copy support is
  deferred until we can verify keyframe cadence from the probe and fall back safely.
- **Audio is encoded once** at a single bitrate and shared across renditions where the
  player supports a separate audio group; otherwise muxed identically into each rung.
- **HDR:** v1 detects HDR10/HLG from colour metadata and either tone-maps to BT.709 SDR
  or rejects the asset, per configuration. Passing HDR through untouched produces washed
  -out playback on SDR displays and is worse than either option.
- **Rotation:** the display matrix is applied during transcode so the output is upright;
  the original rotation is preserved in the probe record.

### Asset lifecycle

```
UPLOADING → UPLOADED → VALIDATING → PROCESSING → PACKAGING → ENCRYPTING → READY
     │          │           │            │            │           │
     └──────────┴───────────┴────────────┴────────────┴───────────┴──▶ FAILED
                                                              READY ──▶ DELETING → DELETED
```

`READY` is a promise: every rendition listed in the master playlist exists in storage,
every hash in the integrity manifest verifies, and the manifest is signed. The API must
never report `READY` on partial output. Intermediate states are reported verbatim through
`GET /assets/{id}/status`.

### Failure handling and resumability

Jobs are decomposed so that a failure costs only the failed unit:

```
process(asset)
 ├── probe            idempotent, cheap, re-runnable
 ├── hash             idempotent
 ├── rendition:720p   independent, idempotent per (asset, rendition, pipeline_version)
 ├── rendition:480p   ─┐ these are parallelisable across workers
 ├── rendition:360p   ─┘
 └── finalize         runs only when all renditions report complete
```

A rendition job's idempotency key is `(asset_id, rendition_name, pipeline_version)`. On
retry it checks storage for a complete, hash-verified output before doing any work. So
"720p ok, 480p ok, 360p failed" retries 360p only.

Errors are surfaced as a stable, documented code plus a retryable flag:

```json
{ "status": "FAILED", "error_code": "TRANSCODING_FAILED", "retryable": true,
  "rendition": "360p", "attempt": 2 }
```

Raw FFmpeg stderr is captured to the job record and exposed only through an
operator-scoped endpoint, never in the public asset response.

### Deletion pipeline

Deletion is a first-class pipeline, not a status flag, because for personal-data video
"prove it is gone" is a requirement rather than a courtesy.

```
 READY ──▶ DELETING
    │
    ├─▶ [1] revoke     every active session for the asset, immediately
    ├─▶ [2] enumerate  LIST storage under every prefix, both buckets
    │                  ── list storage, do NOT trust the database. Failed jobs leave
    │                     orphans that a DB-driven delete would silently miss.
    ├─▶ [3] purge      batch-delete every object found
    ├─▶ [4] shred      destroy the content keys ── the decisive step
    ├─▶ [5] invalidate CDN paths for the asset prefix (best effort)
    ├─▶ [6] redact     filename, probe metadata, viewer identifiers on sessions
    ├─▶ [7] verify     RE-LIST and assert empty. A delete you do not re-check is a
    │                  delete you are guessing about.
    └─▶ [8] attest     write a signed deletion record
 DELETED
```

Step [4] is what makes the guarantee strong. Object deletion is best-effort against
replicas, snapshots and edge caches you cannot enumerate — but anything that survives is
AES-128 ciphertext with no key left anywhere, and is therefore permanently inert. Full
reasoning, including the two operator obligations that can undermine it, is in
[privacy.md §5](privacy.md#5-cryptographic-erasure).

Retention-driven deletion runs the identical job, differing only in the recorded reason.


---

## 5. Adaptive bitrate ladder

Fully configurable; the shipped default is a starting point, not a policy.

```yaml
packaging:
  segment_duration: 4          # seconds; also the forced-keyframe interval
  container: fmp4              # fmp4 (CMAF) | mpegts
  independent_segments: true

ladder:
  allow_upscaling: false       # if true, requires an explicit per-asset override too
  max_bitrate_ratio: 1.1       # never spend more bits than ~the source
  min_renditions: 1
  audio_bitrate: 128k          # CONSTANT across rungs - see below
  renditions:
    - { name: 720p, width: 1280, height: 720, video_bitrate: 2000k }
    - { name: 480p, width: 854,  height: 480, video_bitrate: 1000k }
    - { name: 360p, width: 640,  height: 360, video_bitrate: 600k  }
```

Selection algorithm: drop every rung whose height exceeds the source height; drop every
rung whose target bitrate exceeds `source_bitrate x max_bitrate_ratio`; if that empties the
ladder, keep the single lowest rung and scale it to the source dimensions. Aspect ratio is
preserved by fitting within the rung box and rounding to even dimensions. A 360p source
therefore yields a 360p ladder - never a fabricated 1080p.

### Why this default differs from a general-purpose ladder

The shipped default is tuned for **low-motion, face-and-voice footage** - webcam
recordings, interviews, screen-accompanied conversation - which is the profile Obscura was
built for. Three deliberate departures from a typical VOD ladder:

- **No 1080p rung.** Webcam sources are usually 720p or below, and the ones that report
  1080p are frequently upscaled from less. The ladder's no-upscaling rule would drop the
  rung anyway for most inputs; shipping it only invites wasted CPU on the minority that
  nominally qualify. Add it back for genuinely high-detail sources.
- **Lower video bitrates.** Low-motion content needs far fewer bits than the same
  resolution of general video. 2000k at 720p is generous for a talking head and visibly
  wasteful for nothing.
- **Audio bitrate is constant across the ladder, not scaled down with video.** This is the
  important one. For conversational footage **the audio is the content** - a viewer on a
  poor connection needs to keep hearing the words even as the picture degrades. A ladder
  that drops audio to 64k at the bottom rung optimises the wrong axis. Audio is encoded
  once at 128k and shared across renditions.

Content with genuinely different characteristics wants a different profile. Screen capture
and coding exercises in particular are static, text-heavy, and lose legibility at these
bitrates - if a deployment carries that kind of footage, it needs its own rung set and
encoder tuning rather than these defaults.

---

## 6. Storage architecture

`StorageProvider` exposes exactly what we need and nothing more:

Two endpoints, not one: the URL a browser must use is not always the one the service uses.
Under Docker Compose the service reaches MinIO at `minio:9000` while the browser needs
`localhost:9000`; in a VPC the same split appears between a private endpoint and a public
one. Signing with the internal host produces URLs that are valid and unreachable, so
`S3_PUBLIC_ENDPOINT` is used for signing and `S3_ENDPOINT` for everything else.

```ts
interface StorageProvider {
  put(key: string, body: Readable | Buffer, opts?: PutOptions): Promise<PutResult>;
  get(key: string, range?: ByteRange): Promise<GetResult>;      // streaming
  head(key: string): Promise<ObjectMetadata | null>;
  delete(keys: string[]): Promise<void>;                        // batched
  list(prefix: string, cursor?: string): Promise<ListPage>;     // paginated
  signedUrl(key: string, op: 'GET' | 'PUT', ttl: Seconds, opts?): Promise<string>;
  multipart: { create; uploadPart; complete; abort };            // large sources
}
```

Deliberately *not* on the interface: bucket creation, ACL manipulation, lifecycle
policies, tagging, versioning. Those are deployment concerns configured by the operator,
not runtime behaviour, and including them would tie us to per-vendor semantics.

### Layout

```
videos/{asset_id}/
    source/
        original.<ext>              ← never referenced by any browser-facing URL
    hls/
        master.m3u8                 ← canonical, relative URIs, no tokens
        720p/ init.mp4  seg_00001.m4s  seg_00002.m4s  …  playlist.m3u8
        480p/ …
        360p/ …
        subs/en/ playlist.m3u8  seg_00001.vtt  …
    metadata/
        asset.json                  ← probe output, ladder, pipeline version
        integrity.json              ← full hash set + Merkle tree + signature
```

**Two buckets are recommended, not one.** `source/` and `hls/` are shown under one prefix
for readability, but production deployments should place them in separate buckets with
separate IAM policies: the CDN's origin-access identity gets read access to the
renditions bucket only, and has no path to the source bucket at all. With a single
bucket, a CDN or origin-access misconfiguration exposes the original file; with two, the
same mistake exposes only encrypted derivatives. The storage config accepts
`source_bucket` and `delivery_bucket`, defaulting to the same value for single-bucket
local development.

Buckets are private. No bucket policy ever grants `s3:GetObject` to `*`.

---

## 7. Local development architecture

```
docker compose up
    ├── postgres      schema applied by a migration job on start
    ├── redis
    ├── minio  +  a one-shot job that creates buckets and applies a private policy
    ├── api           :3001
    ├── edge          :3002   (same image, different command)
    ├── worker        image includes ffmpeg; scale with --scale worker=N
    └── player        :3000   Vite dev server
```

Target experience:

```bash
git clone … && cd obscura
cp .env.example .env
docker compose up
open http://localhost:3000        # upload a video, watch it play
```

No AWS account, no R2 account, no CDN. `.env.example` ships with development-only
secrets that are obviously fake, and the API refuses to start with them when
`NODE_ENV=production`. Delivery strategy defaults to `proxy` locally because MinIO
presigned URLs pointing at `localhost:9000` are awkward from inside containers; the
compose file also documents how to switch to `presigned` to exercise that path.

---

## 8. Production deployment architecture

```
                    ┌──────────────┐
    viewers ───────▶│     CDN      │──── origin (OAI / signed origin pull) ──┐
                    └──────┬───────┘                                          │
                           │ /stream/* (manifests, keys)                      ▼
                           ▼                                        ┌──────────────────┐
                    ┌──────────────┐                                │  delivery bucket │
                    │ edge (2..N)  │                                │   (encrypted     │
                    └──────┬───────┘                                │    renditions)   │
                           │                                        └──────────────────┘
    your app ─────▶ ┌──────────────┐                                ┌──────────────────┐
                    │  api (2..N)  │                                │  source bucket   │
                    └──────┬───────┘                                │  (no CDN path)   │
                           │                                        └────────▲─────────┘
              ┌────────────┼────────────┐                                    │
              ▼            ▼            ▼                                    │
         PostgreSQL     Redis      worker (0..N, CPU-heavy) ─────────────────┘
```

- **API and edge** are stateless: run 2+ replicas behind a load balancer, scale on
  requests. They are small; a 1 vCPU / 512 MB instance handles a lot of manifest
  generation.
- **Workers** scale independently and are the only expensive component. They can be
  scaled to zero when the queue is empty; a transcode-heavy hour and an idle hour should
  not cost the same. Spot/preemptible instances are appropriate because jobs are
  resumable by design.
- **Minimum viable production install:** 1 API+edge container, 1 worker, managed
  Postgres, a small Redis, S3/R2, and a CDN. That is a few tens of dollars a month plus
  storage and egress.
- **Kubernetes, ECS and plain VMs** are all supported because the units are ordinary
  containers with health endpoints and no orchestrator-specific assumptions. We ship
  Compose and a Dockerfile; Helm charts and Terraform modules are community/roadmap
  items, not core.
- **Serverless workers** are viable for short videos but a poor fit for long transcodes
  (execution time limits, no local scratch disk, cold FFmpeg images). Documented as
  "supported with caveats," not recommended as the default.

## 9. Repository structure

```
obscura/
├── apps/
│   ├── api/                 control plane (Fastify)
│   ├── edge/                data plane: manifests, keys, optional proxy
│   ├── worker/              queue consumer; image bundles ffmpeg
│   ├── player/              reference React + hls.js player
│   └── cli/                 obscura
├── packages/
│   ├── shared/              types, error codes, config schema, canonical JSON
│   ├── storage/             StorageProvider + S3 implementation
│   ├── media/               ffprobe/ffmpeg wrappers, ladder logic, HLS packaging
│   ├── encryption/          KeyProvider, envelope encryption, HLS key handling
│   ├── integrity/           hashing, Merkle tree, signing, verification
│   ├── watermark/           policy, renderers, providers
│   ├── auth/                API keys, JWT, callbacks, playback tokens
│   ├── delivery/            DeliveryStrategy + CDN signers
│   └── db/                  migrations, queries, repositories
├── docker/                  Dockerfiles, compose overlays
├── docs/                    architecture, security, threat model, ADRs
├── examples/                s3/ r2/ minio/ cloudfront/ cloudflare/ integration/
├── tests/                   integration + e2e; fixtures/ holds generated media
├── docker-compose.yml
├── README.md · LICENSE · CONTRIBUTING.md · SECURITY.md · CODE_OF_CONDUCT.md
└── .env.example
```

Changes from the structure in the original brief, and why:

- **`apps/edge` added.** Separating the byte/manifest path from the control plane is the
  difference between "can be scaled and firewalled independently" and "cannot." It is
  cheap to do now and expensive to retrofit.
- **`packages/streaming` split into `media` + `delivery`.** Producing HLS and authorizing
  its delivery are unrelated concerns with different dependencies; the worker needs
  `media` and not `delivery`, and `edge` needs the reverse.
- **`packages/db` added.** Migrations and repositories need a home that is not `shared`.
- **Tooling:** npm workspaces (no global install needed — `git clone && npm install`
  works with the Node already required) and TypeScript project references for the build
  graph. Vitest for unit, integration and end-to-end tests.

See [ADR-0010](adr/0010-repository-structure.md).
