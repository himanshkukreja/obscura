# Privacy, retention and deletion

Obscura was built for video that is somebody's personal data. This document is therefore
a design specification, not a policy statement — everything here is a feature with code
behind it.

**This is engineering documentation, not legal advice.** Deployers are responsible for
their own obligations and should have counsel confirm them.

---

## 1. Roles

Under GDPR-style regimes the split is:

```
The person in the video          data subject
Your application / company       data controller  — decides why the video exists
Obscura (self-hosted by you)     part of your own processing, not a third party
Your cloud storage / CDN         your sub-processors
```

**Obscura is not a service you send data to.** You run it inside your own infrastructure,
against your own buckets. There is no vendor in the middle, no telemetry, and no network
call to anyone but your own storage. For a controller, that removes an entire class of
sub-processor paperwork — and it is one of the better arguments for self-hosting a
delivery layer rather than using a SaaS one.

## 2. Data inventory

Everything Obscura stores, why, and for how long. This table is intended to be usable
directly in a record of processing.

| Data | Where | Why | Default retention | Configurable |
|---|---|---|---|---|
| Source video | Object storage (source bucket) | The asset itself | Until deleted | Per-asset TTL |
| Renditions and segments | Object storage (delivery bucket) | Playback | Until deleted | Per-asset TTL |
| `original_filename` | `assets` | Operator recognition | Until deleted | Can be suppressed at ingest |
| `ffprobe` output | `assets.probe` | Pipeline decisions | Until deleted | — |
| Content keys (wrapped) | `content_keys` | Decrypting segments | Until deleted | — |
| `subject_ref` (opaque viewer id) | `playback_sessions` | Authorization, limits, audit | 90 days | Yes |
| `subject_label` (watermark text) | `playback_sessions` | Overlay rendering | 90 days | Yes |
| IP address | `playback_sessions` | Abuse detection | **Salted hash**, 90 days | `none` / `hashed` / `raw` |
| User agent | `playback_sessions` | Abuse detection | **Salted hash**, 90 days | `none` / `hashed` / `raw` |
| Access events | `session_events` | Who viewed what, when | 30 days | Yes |
| Administrative audit | `audit_log` | Accountability | 365 days | Yes |
| Integrity manifest | Object storage + `assets` | Provenance | Until deleted | — |
| **Deletion record** | `deletion_records` | **Proof of destruction** | **Indefinite** | No — see §5 |

**Never collected, in any configuration:** device fingerprints, geolocation, third-party
analytics, cross-site identifiers, viewing-behaviour profiles.

```yaml
privacy:
  store_ip: hashed            # none | hashed | raw
  store_user_agent: hashed
  ip_hash_salt_rotation_days: 30
  store_original_filename: true
retention:
  playback_sessions_days: 90
  session_events_days: 30
  audit_log_days: 365
  failed_jobs_days: 30
  asset_default_ttl_days: null    # null = keep until explicitly deleted
```

Event tables are time-partitioned, so retention is a partition drop rather than a
long-running `DELETE`. A scheduled job enforces it; retention that depends on someone
remembering to run something is not retention.

## 3. Minimisation by design

- **The viewer identifier is opaque.** Obscura never needs an email, a name, or anything
  else. Your application passes whatever token resolves to a person in *your* records.
- **IP and user agent default to salted hashes.** A hash still answers "is this the same
  client as before?" for abuse detection without retaining an identifier. The salt rotates,
  which bounds correlation over time. Raw storage exists for deployments that need it and
  have a basis for it.
- **Watermark text is a deliberate choice, not a default.** See
  [watermarking.md](watermarking.md#watermark-text-is-personal-data).
- **Filenames leak.** `candidate-jane-doe-final.mp4` is personal data sitting in a
  database column and in operator-facing API responses. `store_original_filename: false`
  discards it at ingest, keeping only the content type.

## 4. Verified deletion

`DELETE /api/v1/assets/{id}` is not a status flag. It is a job that **proves** the content
is gone.

```
DELETE request
   │
   ├─ 1. status → DELETING; revoke every active session for the asset immediately
   │
   ├─ 2. LIST object storage under every prefix for this asset, in both buckets
   │       ── list storage, do NOT trust the database's record of what exists.
   │          Failed jobs leave orphans; a DB-driven delete would miss them.
   │
   ├─ 3. Batch-delete every object found
   │
   ├─ 4. DESTROY the content keys  ◀── the decisive step, see §5
   │
   ├─ 5. Invalidate CDN paths for the asset prefix (best effort)
   │
   ├─ 6. Purge identifying database columns: filename, probe metadata, subject_ref and
   │      subject_label on associated sessions
   │
   ├─ 7. RE-LIST storage and assert empty ── the verification pass.
   │      A delete that is not re-checked is a delete you are guessing about.
   │
   └─ 8. Write a signed deletion record; status → DELETED
```

### What survives, and why

Proving a deletion happened requires keeping *something*. Obscura keeps the minimum that
is not itself personal data:

| Retained | Destroyed |
|---|---|
| `asset_id` | All media bytes |
| `source_sha256` and derivative roots | Content keys |
| Timestamps, object count, verification result | Original filename |
| Who requested it and why | Probe metadata |
| The signature over all of the above | Viewer identifiers on associated sessions |

A SHA-256 is one-way and cannot reconstruct or identify the video, so retaining it
preserves the ability to answer "did you ever hold this file, and what became of it?"
without retaining the file or anything about the person in it.

```json
{
  "schema": "obscura.deletion/v1",
  "asset_id": "018f3c1e-…",
  "source_sha256": "e3b0c442…",
  "asset_root": "…",
  "requested_at": "2026-09-21T09:12:00Z",
  "requested_by": "api_client:018e…",
  "reason": "data_subject_request",
  "completed_at": "2026-09-21T09:12:41Z",
  "objects_deleted": 1843,
  "storage_verified_empty": true,
  "content_keys_destroyed": 1,
  "cdn_invalidation": { "requested": true, "provider": "cloudfront", "id": "I2J…" },
  "sessions_revoked": 3,
  "signature": { "algorithm": "Ed25519", "key_id": "obscura-integrity-2026-01",
                 "canonicalization": "RFC8785", "value": "…" }
}
```

## 5. Cryptographic erasure

**Destroying the content key is the strongest deletion control Obscura has**, and it is
the reason encryption earns its place even for a deployment with no piracy concern at all.

Object deletion is best-effort against infrastructure you do not fully control. Bucket
replicas, point-in-time snapshots, a CDN edge that ignores an invalidation, a backup taken
an hour before the request — none of these are reachable by a `DELETE` call. Segments may
survive in places you cannot enumerate, let alone erase.

They are also **AES-128 ciphertext with no key anywhere in the world.** Once the wrapped
key row is destroyed, every one of those copies is permanently unreadable. This converts
"we deleted everything we could find" into "everything that remains is cryptographically
inert" — a much stronger statement, and one a deletion record can honestly assert.

Two conditions must hold, and both are the operator's responsibility:

1. **Database backups must not outlive the deletion.** A backup of `content_keys` from
   before the request, restored later, resurrects the key. Key rows should be excluded
   from long-lived logical backups, or backup retention kept shorter than deletion SLA.
2. **The master key must be protected accordingly.** Under KMS, scheduling key material
   for destruction gives the same property at the master level, with an audit trail.

This is documented in `docs/deployment.md` as a deployment requirement, because a
correctly implemented purge can still be undone by a backup policy nobody reviewed.

## 6. Access transparency

"Who has viewed this person's recording?" is both a compliance answer and a product
feature. `playback_sessions` joined with `session_events` provides it directly:

```http
GET /api/v1/assets/{id}/access-log?from=&to=&cursor=
```

```json
{ "data": [
  { "session_id": "s_9d8c…", "subject_ref": "user_8812",
    "started_at": "2026-09-20T14:02:11Z", "last_seen_at": "2026-09-20T14:31:47Z",
    "events": { "manifest": 1, "key": 12, "heartbeat": 29 },
    "watched_seconds_estimate": 1776 } ] }
```

Watch duration is **estimated from heartbeat and key-fetch counts**, deliberately. Precise
playback telemetry would mean building behavioural tracking, which contradicts §3. The
estimate is enough to distinguish "opened it" from "watched it" without profiling anyone.

## 7. Subject rights

| Right | How Obscura supports it |
|---|---|
| Erasure | §4 verified deletion, with a signed record |
| Access / portability | `GET /assets/{id}` and `/metadata` return everything held about an asset; the access log covers session data |
| Restriction | Revoke all sessions for an asset and refuse new ones, without deleting |
| Rectification | Not applicable — Obscura does not hold assertions about people, only media and access records |
| Objection | A controller concern; Obscura enforces the resulting decision via deletion or restriction |

Obscura is the enforcement mechanism, not the decision-maker. Your application decides a
request is valid; Obscura makes the outcome real and provable.
