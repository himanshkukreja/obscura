# Testing strategy

Tests are written alongside implementation, not after. Each phase in
[roadmap.md](roadmap.md) has exit criteria expressed as tests that must exist and pass.

## Layers

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | Ladder selection, Merkle tree, manifest rewriting, token signing/validation, canonical JSON |
| Integration | Vitest + Testcontainers | Real PostgreSQL, Redis, MinIO and FFmpeg. No mocking of storage or the media pipeline. |
| End-to-end | Playwright | Real browser, real hls.js, real playback against a Compose stack |

**Media is never mocked.** A mocked FFmpeg proves nothing about the thing most likely to
be wrong. Fixtures are generated on demand by FFmpeg (`tests/fixtures/generate.sh`) so the
repository carries scripts, not binaries.

## Fixture matrix

Generated: valid H.264/AAC MP4 · MOV · MKV · WebM · AVI · M4V · 360p source (ladder must
not upscale) · 4K source · audio-only · video without audio · variable frame rate ·
rotated (90°, display matrix) · HDR10 · long GOP · a deliberately corrupt file · a
zero-byte file · a file whose extension contradicts its content.

## Required tests by concern

**Storage** — every `StorageProvider` operation against MinIO; the same suite runs against
real S3 and R2 in an opt-in, credentialed CI job; multipart upload and abort; ranged reads;
paginated listing past one page.

**Processing** — each fixture above produces the expected ladder, or the expected typed
rejection. Probe output is parsed correctly for every fixture. Transcode is idempotent:
running a rendition job twice produces byte-identical output and the second run skips
work.

**The keyframe-alignment test** — assert that segment-boundary presentation timestamps are
identical across every rendition of an asset. This is the single most important pipeline
test in the project; a stream that fails it plays fine in casual testing and stutters on
quality switches in production.

**Security** —
expired token rejected · token for a different asset rejected · token for a revoked
session rejected · token with a tampered signature rejected · `alg: none` and symmetric
JWTs rejected · replayed `jti` beyond threshold rejected · concurrent-session limit
enforced · rate limits enforced · authorization callback timeout fails **closed** ·
key endpoint denies immediately after revocation · **no response body or header anywhere
in the system contains the source object key** · **a full playback run's logs contain no
token and no key material** (grep assertion over captured log output).

**Integrity** — source hash matches a known value · rendition and segment hashes match ·
Merkle root is stable across runs · a Merkle proof verifies · a proof for the wrong
segment fails · flipping one byte in storage is detected and reported precisely ·
signature verifies against the published public key · a manifest re-serialized with
different key ordering still verifies (canonicalization).

**Deletion** — this is the phase most likely to be quietly wrong, so it gets the most
adversarial tests.
`DELETE` leaves zero objects under every asset prefix in both buckets · **an orphaned
object seeded from a simulated failed job is still found and removed** (the purge lists
storage rather than trusting the database, and this is the test that proves it) · content
key rows are destroyed, not marked revoked · **segments retained out-of-band remain
undecryptable after key destruction** · active sessions are revoked before objects are
removed · the signed deletion record verifies and reports the real object count ·
`GET /assets/{id}/deletion-record` still answers after the asset row is gone ·
identifying columns are purged while hashes are retained · retention jobs drop the correct
partitions and no others · a partially failed purge is resumable and does not report
success.

**Privacy** — `store_ip: none` writes no IP anywhere · `hashed` writes no recoverable
value and rotates salt · `store_original_filename: false` keeps no filename in the
database or any API response · the access log estimates watch time without recording
positions.

**Playback** — master and variant playlists parse · segment authorization succeeds and
fails correctly · key authorization succeeds and fails correctly · session expiry ends
playback with a distinguishable error · ABR switching occurs under simulated bandwidth
change · subtitles load · the player degrades gracefully on a 401 mid-playback rather than
showing a generic failure.

## CI

Every pull request: lint, typecheck, unit, integration (Testcontainers), licence check
(fails on any non-MIT/Apache-2.0/BSD/ISC runtime dependency), secret scanning, container
image scanning. End-to-end and the credentialed S3/R2 suites run on merge to main and
nightly.
