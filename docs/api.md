# API design

Two surfaces with different audiences, different authentication and different exposure:

| Surface | Prefix | Called by | Auth |
|---|---|---|---|
| **Control** | `/api/v1/*` | Your backend, server-to-server | API key / JWT |
| **Delivery** | `/stream/*` | The browser's player | URL-bound playback token |

The split is deliberate. `/api/v1` can sit behind stricter network policy and needs no
CORS; `/stream` is public-facing, CORS-enabled and CDN-fronted. They are separate route
trees so they can be separate deployments.

## Conventions

- JSON request and response bodies; `application/json; charset=utf-8`.
- Cursor pagination: `?cursor=&limit=` → `{ "data": [...], "next_cursor": "..." }`.
  Never offset pagination — it breaks under concurrent inserts.
- `Idempotency-Key` header honoured on every mutating request; replays return the original
  response.
- Errors are a single stable shape with a documented, machine-readable code:

```json
{ "error": { "code": "asset_not_ready", "message": "Asset is still PROCESSING.",
             "status": "PROCESSING", "retryable": true },
  "request_id": "01J8…" }
```

- Every response carries `X-Request-Id`; every log line carries the same value.
- Versioning: `/api/v1` is frozen once 1.0 ships. Additive changes only; breaking changes
  get `/api/v2`.

---

## Control plane

### Assets

```http
POST   /api/v1/assets
```
```json
{ "original_filename": "training-video.mp4", "content_type": "video/mp4",
  "size": 123456789, "external_ref": "course-12-lesson-3", "title": "Lesson 3",
  "sha256": "optional — verified after upload if supplied" }
```
```json
{ "asset_id": "018f…", "status": "UPLOADING",
  "upload": { "method": "PUT", "url": "https://…", "headers": {…},
              "expires_at": "2026-09-20T23:55:00Z" } }
```

For sources above a configured threshold the response instead carries a multipart plan.
The API never receives upload bytes.

```http
POST   /api/v1/assets/{id}/commit
```
Verifies the object exists and matches the declared size (and `sha256` if supplied), moves
the asset to `UPLOADED`, and enqueues processing. This is the trust boundary — nothing is
processed on the client's word alone.

```http
GET    /api/v1/assets?status=&external_ref=&cursor=&limit=
GET    /api/v1/assets/{id}
POST   /api/v1/assets/{id}/process  # (re)process; Idempotency-Key; ?force=true
GET    /api/v1/assets/{id}/status
GET    /api/v1/assets/{id}/metadata
```

`GET /assets/{id}/status` — the endpoint your UI polls:

```json
{ "asset_id": "018f…", "status": "PROCESSING", "progress": 0.62,
  "renditions": [ { "name": "1080p", "status": "complete" },
                  { "name": "720p",  "status": "running", "progress": 0.24 },
                  { "name": "480p",  "status": "pending"  } ],
  "error_code": null, "retryable": null,
  "estimated_completion": "2026-09-20T23:58:00Z" }
```

On failure:

```json
{ "status": "FAILED", "error_code": "TRANSCODING_FAILED", "retryable": true,
  "failed_target": "720p", "attempt": 2 }
```

FFmpeg stderr is never in this response. It is available at
`GET /api/v1/assets/{id}/jobs/{job_id}/log` under an operator scope.

### Subtitles

```http
POST   /api/v1/assets/{id}/subtitles           # upload target for WebVTT or SRT
POST   /api/v1/assets/{id}/subtitles/import    # inline timed text (transcript import)
GET    /api/v1/assets/{id}/subtitles
DELETE /api/v1/assets/{id}/subtitles/{track_id}
```

SRT is converted to WebVTT during processing; the original is retained. TTML is a future
input format.

`/import` accepts timed segments directly, so a platform that already holds a transcript
can turn it into subtitles without producing a file:

```json
{ "language": "en", "label": "English",
  "cues": [ { "start_ms": 0, "end_ms": 3200, "text": "Tell me about yourself." } ] }
```

This is usually the highest-value-per-line feature available to any deployment that
already transcribes its media — viewers skim transcripts more than they watch video.

### Integrity

```http
GET /api/v1/assets/{id}/integrity
GET /api/v1/assets/{id}/integrity/proof?rendition=1080p&segment=42
GET /.well-known/obscura-integrity-keys.json      # public, unauthenticated
```

The proof response is a Merkle inclusion proof plus the signed root, so a third party can
verify one segment without our cooperation and without the full hash set.

### Deletion

```http
DELETE /api/v1/assets/{id}
```
```json
{ "reason": "data_subject_request", "requested_by": "privacy-team@acme.com" }
```
```json
{ "asset_id": "018f…", "status": "DELETING", "deletion_id": "018f…",
  "sessions_revoked": 3 }
```

Returns immediately; the purge is a job. Poll `GET /assets/{id}/status` or fetch the
record:

```http
GET /api/v1/assets/{id}/deletion-record
```

Returns the signed record described in
[privacy.md §4](privacy.md#4-verified-deletion) — object count, whether storage was
verified empty, whether content keys were destroyed, CDN invalidation state, and a
signature over all of it. **This endpoint keeps working after the asset is gone**; that is
the point of it. It is the artifact you hand to whoever asked.

`reason` is recorded, not interpreted: `data_subject_request` | `retention` | `operator` |
`client_request`.

### Access log

```http
GET /api/v1/assets/{id}/access-log?from=&to=&cursor=
```

Who viewed this asset and when — a compliance answer and a product feature. Watch duration
is **estimated** from heartbeat and key-fetch counts rather than tracked precisely; see
[privacy.md §6](privacy.md#6-access-transparency).

### Playback sessions

```http
POST /api/v1/assets/{id}/playback-session
Authorization: Bearer <application credential>
Idempotency-Key: <optional>
```
```json
{ "subject_ref": "user_8812",
  "subject_label": "himanshu@example.com",
  "ttl_seconds": 3600,
  "watermark": { "text_template": "{{user.label}} · {{asset.short_id}}" },
  "client_binding": "optional base64 value the player will echo back" }
```
```json
{ "session_id": "s_9d8c…",
  "token": "…",
  "manifest_url": "https://media.example.com/stream/s_9d8c…/master.m3u8?t=…",
  "expires_at":   "2026-09-21T00:40:00Z",
  "token_expires_at": "2026-09-20T23:43:00Z",
  "refresh_after": 120,
  "watermark": { "text": "recruiter@acme.com · INT-4821",
                 "position": "dynamic", "interval_seconds": 15, "opacity": 0.35 } }
```

Notes:

- `subject_label` is what the watermark renders, and it should identify **the viewer**,
  not the asset — see [watermarking.md](watermarking.md#put-the-viewer-in-the-watermark-not-the-asset).
  A pseudonym or internal user id gives the same attribution with less exposure.
- `refresh_after` tells the player when to heartbeat — the client should not have to
  reason about token lifetimes.
- The watermark is rendered by the player as an overlay; no media is generated per
  viewer, so a session is available immediately ([ADR-0012](adr/0012-watermarking-overlay-only.md)).
- Rejected on limits, with a distinguishable code:

```json
{ "error": { "code": "concurrent_session_limit", "limit": 2, "active": 2,
             "retry_after": 30 } }
```

```http
POST   /api/v1/playback/{session_id}/heartbeat   → refreshed token, or 401 once revoked
DELETE /api/v1/playback/{session_id}             → revoke immediately
GET    /api/v1/playback/sessions?subject_ref=&asset_id=&active=true
DELETE /api/v1/playback/sessions?subject_ref=    → revoke all for a subject
```

Bulk revocation by subject is what you reach for when an employee leaves or an account is
compromised, so it is a first-class endpoint rather than a loop over session ids.

---

## Delivery plane

Called by the player. Token in the query string — see
[security-model.md](security-model.md#why-tokens-live-in-urls) for why it cannot be a
header.

```http
GET /stream/{session_id}/master.m3u8?t=<token>
GET /stream/{session_id}/{rendition}/playlist.m3u8?t=<token>
GET /stream/{session_id}/subs/{track}/playlist.m3u8?t=<token>
GET /stream/{session_id}/key/{kid}?t=<token>
GET /stream/{session_id}/seg/{rendition}/{index}?t=<token>     # `proxy` strategy only
```

| Endpoint | Cache | Notes |
|---|---|---|
| manifests | `private, max-age=10` | Generated per session; small. Short TTL because segment URIs may be signed and expiring. |
| key | **`no-store`** | Always hits the database. The revocation choke point. Strict CORS allowlist, per-session rate limit, `jti` replay tracking. |
| segments | `public, max-age=31536000, immutable` | Identical bytes for all viewers, encrypted. In `presigned`/`cdn_signed` the player is redirected to, or given, a storage/CDN URL and these bytes never touch our servers. |

The `proxy` segment endpoint honours `Range` correctly (206, `Accept-Ranges`,
`Content-Range`) — players and browsers depend on it.

### Operations

```http
GET /healthz     # liveness, no dependency checks
GET /readyz      # DB, Redis, storage reachability
GET /metrics     # Prometheus
```

## Endpoints deliberately not offered

| Not offered | Why |
|---|---|
| `GET /assets/{id}/download` | The entire point of the project |
| `GET /assets/{id}/source-url` | Same |
| Anything returning a content key outside `/stream/{sid}/key/{kid}` | Keys leave through exactly one audited, rate-limited path |
| User/role/permission CRUD | Your application owns identity |
| Raw FFmpeg parameter passthrough | An arbitrary-argument channel into a subprocess is a command-injection surface. Transcode behaviour is configured through a validated schema. |
| Synchronous `POST /transcode` returning finished media | Long jobs do not belong in a request |
| Any endpoint that un-deletes an asset | Deletion is attested as irreversible. An endpoint that could reverse it would make the deletion record a lie. |
| Precise playback position tracking | Behavioural profiling; contradicts [privacy.md §3](privacy.md#3-minimisation-by-design) |

## Client integration sketch

```ts
// your backend
const res = await fetch(`${OBSCURA_URL}/api/v1/assets/${assetId}/playback-session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${OBSCURA_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ subject_ref: user.id, subject_label: user.displayName }),
});
const session = await res.json();   // hand to the browser; never expose OBSCURA_API_KEY

// browser
const hls = new Hls({
  xhrSetup: (xhr, url) => { /* token already in the URL; nothing to add */ },
});
hls.loadSource(session.manifest_url);
hls.attachMedia(videoEl);
setInterval(() => heartbeat(session.session_id), session.refresh_after * 1000);
```

The OpenAPI document is generated from the Fastify JSON Schemas, so it cannot drift from
the implementation, and is published at `/api/v1/openapi.json`.
