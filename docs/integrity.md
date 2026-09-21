# Integrity and provenance

## 1. Three different questions

These are routinely conflated, and conflating them is how people end up making claims
that do not hold.

| | Question | Answered by | Verdict it yields |
|---|---|---|---|
| **Integrity** | Are these bytes exactly the bytes we produced? | SHA-256 over the artifact | Yes / no. Binary. |
| **Provenance** | Did *our* pipeline produce these bytes, from *this* source? | Ed25519 signature over a Merkle root binding source hash + pipeline version + every derivative hash | Yes / no, attributable to our signing key. |
| **Forensic attribution** | Which playback session produced this leaked copy? | Watermark detection + session records | A session, and therefore a subject, with a confidence level. |

Integrity and provenance are cryptographic and exact. Forensic attribution is
probabilistic and depends entirely on the watermarking mode in use — see
[watermarking.md](watermarking.md).

## 2. What a hash does not prove

**A SHA-256 hash proves byte-level identity and nothing else.**

If someone re-encodes one of our renditions, adds a caption, trims two seconds, or even
just remuxes the identical video stream into a different container, the hash changes
completely. That tells us the bytes differ. **It does not tell us the content is fake,
doctored, or unauthorised** — a lossless container change produces a total hash mismatch
while the pixels are identical.

The inverse also matters: a matching hash proves the bytes are ours, but says nothing
about whether the *source* we ingested was authentic. We attest to what we did with the
file we were given, not to the truth of its contents.

So this project will never say, and its API will never imply:

- ❌ "This video is fake because the hash does not match."
- ❌ "Hash verification proves this recording was not edited."
- ❌ "We can detect tampering in any copy of this video."

What it does say:

- ✅ "These bytes are byte-identical to what our pipeline produced on 2026-09-20 from a
  source with SHA-256 `abc…`, and that claim is signed by key `kid=…`."
- ✅ "This segment is provably a member of the signed asset, here is the Merkle proof."
- ✅ "These bytes are *not* the ones we produced." — which is a real, useful negative.

Answering "is this visually the same content, despite re-encoding?" requires **perceptual
hashing** (pHash, TMK+PDQF) — a different tool for a different question, explicitly out
of scope for v1 and named here so nobody expects SHA-256 to do its job.

## 3. The hash tree

```
source/original.mp4
   │ SHA-256
   ▼
source_sha256 ──────────────────────────────┐
                                            │
For each rendition:                         │
   init.mp4    ─ SHA-256 ─┐                 │
   seg_00001   ─ SHA-256 ─┤                 │
   seg_00002   ─ SHA-256 ─┤─ Merkle tree ─▶ rendition_root
   …                      │                 │      │
   playlist.m3u8 ─ SHA-256┘                 │      │
                                            │      ▼
                                            └─▶ asset_root ─ Ed25519 ─▶ signature
                                                   ▲
   subtitle tracks ─ SHA-256 ─▶ track_root ────────┤
   asset.json (probe, ladder, pipeline version) ───┘
```

### Merkle tree construction

- Binary tree over segment hashes in playlist order. Leaves are
  `SHA-256(0x00 || segment_bytes)`; internal nodes are `SHA-256(0x01 || left || right)`.
  The domain-separation prefixes prevent second-preimage attacks where an internal node
  is presented as a leaf — a standard, cheap precaution (RFC 6962 style).
- Odd nodes are promoted, not duplicated. Duplicating the last node is the flaw that
  caused Bitcoin's CVE-2012-2459 and there is no reason to repeat it.
- The leaf count is bound into the root computation so a tree cannot be reinterpreted at
  a different size.

### Why a Merkle tree rather than a flat list

A flat list of hashes is enough to verify everything. The tree adds one specific
capability: **verifying a single segment without transferring the whole hash set.**

For a 2-hour asset at 4-second segments across four renditions, the hash list is ~7,200
entries, roughly 500 KB of JSON. A Merkle proof for one segment is ~13 hashes, about
400 bytes. That is the difference between "spot-checking a suspect segment is practical"
and "nobody will bother." It also lets a future player verify segments incrementally
during playback without downloading the manifest's full hash set up front.

The tradeoff is implementation complexity and one more thing to get right. It is worth it
at asset scale; for very short assets the flat list in the same document is sufficient and
is always present anyway.

## 4. The integrity manifest

Stored at `videos/{asset_id}/metadata/integrity.json`, also returned by
`GET /api/v1/assets/{id}/integrity`.

```json
{
  "schema": "obscura.integrity/v1",
  "asset_id": "018f3c1e-…",
  "created_at": "2026-09-20T23:40:00Z",
  "pipeline": {
    "version": "1.0.0",
    "ffmpeg": "8.0",
    "ladder_config_sha256": "…",
    "packaging": { "container": "fmp4", "segment_duration": 4 }
  },
  "source": {
    "sha256": "e3b0c442…",
    "size": 123456789,
    "content_type": "video/mp4",
    "original_filename": "training-video.mp4",
    "probe_sha256": "…"
  },
  "renditions": [
    {
      "name": "1080p",
      "width": 1920, "height": 1080,
      "encryption": { "method": "AES-128", "kid": "…" },
      "playlist_sha256": "…",
      "init_sha256": "…",
      "segment_count": 1800,
      "merkle_root": "…",
      "segments": [ { "index": 0, "sha256": "…", "size": 987654 } ]
    }
  ],
  "subtitles": [ { "language": "en", "playlist_sha256": "…", "merkle_root": "…" } ],
  "asset_root": "…",
  "signature": {
    "algorithm": "Ed25519",
    "key_id": "obscura-integrity-2026-01",
    "canonicalization": "RFC8785",
    "value": "…"
  }
}
```

Notes on the design:

- **Segment hashes are in this document, in object storage — not in PostgreSQL.** One row
  per segment would mean ~7,200 rows for a single 2-hour asset and tens of millions across
  a modest library, for data that is written once, read rarely, and always read together.
  PostgreSQL stores only the roots, the playlist hashes and the signature. This is a
  deliberate decision; see [data-model.md](data-model.md).
- The document is signed over its **RFC 8785 (JCS) canonical form**, so verification does
  not depend on key ordering or whitespace. Signing raw JSON bytes is the usual way this
  breaks in practice.
- `signature` is excluded from the canonicalized payload.
- The signature covers `asset_root`, which covers everything else, so tampering anywhere
  in the tree invalidates it.
- Hashes are of **encrypted segment bytes as stored** — the bytes a CDN serves and an
  auditor can fetch. Verifying without possessing content keys is the point.

## 5. Signing keys

- Ed25519. Small, fast, no parameter choices to get wrong, no nonce-reuse failure mode.
- Private key from `IntegritySigner`, which is `KeyProvider`-backed: env-supplied in v1,
  KMS later. Never in object storage, never in the database, never logged.
- Public keys are published at `GET /.well-known/obscura-integrity-keys.json` (a JWKS-shaped
  document) so third parties can verify our manifests without our cooperation. That is
  what makes provenance claims meaningful rather than self-referential.
- Keys are identified by `key_id` and rotated on a schedule; retired public keys stay
  published indefinitely, because old manifests must remain verifiable forever.

## 6. Verification

```bash
obscura verify <asset-id>              # fetch manifest, verify signature, check every
                                      # object's hash against storage
obscura verify <asset-id> --quick      # signature + playlist hashes only
obscura verify --file suspect.m4s --proof proof.json   # is this segment ours?
```

```
GET /api/v1/assets/{id}/integrity
GET /api/v1/assets/{id}/integrity/proof?rendition=1080p&segment=42
```

`verify` exits non-zero on any mismatch and prints exactly what differed. The output must
distinguish, in plain language, "this file is not ours" from "this file is a modified
version of ours" from "this file is visually similar but we cannot say anything about it"
— the third being the honest answer for any re-encoded copy.

## 7. Threats this addresses

| Scenario | Covered? |
|---|---|
| A CDN or storage layer serves altered segments | Yes — hash mismatch against a signed manifest |
| Silent bit rot in object storage | Yes — periodic re-verification job |
| An operator swaps a rendition after the fact | Yes — signature no longer verifies |
| "Prove this is the file you gave us in March" | Yes — signed manifest with timestamps |
| "Prove this leaked copy is a re-encode of your video" | **No** — that needs perceptual hashing plus watermark detection |
| "Prove the source video itself is authentic" | **No** — we attest to our processing, not to the truth of the input |
| "Prove you destroyed this asset" | Yes — the same signing key produces a deletion record; see [privacy.md §4](privacy.md#4-verified-deletion) |

## 7b. Integrity records outlive the media

When an asset is deleted, its integrity manifest goes with it — but the **root hashes and
the signature survive**, inside the deletion record. That is deliberate. A SHA-256 is
one-way and identifies nothing, so retaining it costs no privacy while preserving the
ability to answer "did you ever hold this file, and what became of it?" long after the
file is gone.

It also means the same signing key underwrites both claims Obscura makes about an asset —
*this is what we produced* and *this is what we destroyed* — which keeps verification
tooling to one code path and one published public key.

## 8. Roadmap

| Phase | Capability |
|---|---|
| v1 | Source and derivative hashes, per-rendition Merkle trees, signed manifest, verify API and CLI |
| v1.x | Scheduled re-verification job; published public-key endpoint; proof endpoint |
| v2 | KMS-backed signing; transparency-log style append-only record of asset roots |
| v3 | C2PA alignment for assets that need interoperable provenance; perceptual hashing as a separate, clearly labelled capability |
