# ADR-0007 — Merkle trees over segments, signed with Ed25519

**Status:** Accepted · 2026-09-20

## Context
We need to prove that delivered bytes are the bytes our pipeline produced, and that our
pipeline produced them from a specific source. A flat list of SHA-256 hashes answers the
first question but scales badly for spot-verification.

## Decision
SHA-256 every artifact. Build a **Merkle tree** per rendition over segment hashes, combine
rendition roots and metadata hashes into an asset root, and sign that root with
**Ed25519** over the **RFC 8785 (JCS) canonical form** of the manifest. Publish the public
keys.

Leaves are `SHA-256(0x00 || bytes)`, internal nodes `SHA-256(0x01 || left || right)`. Odd
nodes are promoted, not duplicated.

## Alternatives considered

**Flat hash list only.** Simpler. Rejected: a 2-hour asset across four renditions is
~7,200 hashes (~500 KB). Verifying one suspect segment would mean transferring all of
them, so nobody would. A Merkle proof is ~400 bytes.

**Signing the raw JSON bytes.** Rejected: verification then depends on key ordering and
whitespace, which is the usual way this breaks in the field.

**Duplicating the last node for odd levels.** Rejected — that is the flaw behind Bitcoin
CVE-2012-2459. No reason to repeat it.

**RSA or ECDSA.** Rejected: more parameters to get wrong, and ECDSA has a nonce-reuse
failure mode. Ed25519 has neither.

**Blockchain anchoring / C2PA in v1.** Rejected as premature. C2PA is worth aligning with
later but targets capture-to-publish workflows, not encrypted segment delivery.

## Consequences
- Third parties can verify our manifests without our cooperation, which is what makes a
  provenance claim meaningful rather than self-referential.
- Per-segment hashes live in `integrity.json` in object storage, not PostgreSQL — the
  database stores only roots. This avoids tens of millions of rows of write-once,
  read-together data.
- Hashes are of **encrypted segment bytes as stored**, so verification needs no content
  keys.
- Retired public keys must stay published indefinitely; old manifests have to remain
  verifiable forever.
- **Documented limit:** a hash proves byte identity and nothing more. It cannot show that
  a re-encoded copy is "fake". The API and CLI must never imply otherwise.
