# ADR-0011 — Deletion is a verified, attested pipeline, not a status flag

**Status:** Accepted · 2026-09-21

## Context
Obscura's driving use case is video that is personal data — recordings of identifiable
people, subject to erasure rights with statutory deadlines. "Mark the row deleted and let a
lifecycle rule clean up" is the normal implementation and it cannot answer the question
that actually gets asked: *prove it is gone.*

Three things make a naive delete unsound:

1. **The database does not know what exists.** Failed or partially retried jobs leave
   orphaned objects in storage that no table references.
2. **Some copies are unreachable.** Bucket replicas, point-in-time snapshots, backups, and
   CDN edges that ignore invalidations cannot be enumerated, let alone erased.
3. **Nobody re-checks.** A delete that is never verified is a delete you are guessing
   about.

## Decision
`DELETE /assets/{id}` runs an eight-step job that **enumerates storage rather than trusting
the database**, deletes, **destroys the content key**, invalidates CDN paths, redacts
identifying columns, **re-lists and asserts empty**, and writes an **Ed25519-signed
deletion record** that survives the asset indefinitely.

Retention-driven deletion runs the identical job, differing only in the recorded reason.

## Alternatives considered

**Soft delete plus a storage lifecycle rule.** Cheap and conventional. Rejected: lifecycle
rules are eventually-consistent, unverifiable, invisible to the application, and silently
skip orphans.

**Delete from the database's object list.** Rejected: it misses exactly the objects most
likely to exist by accident.

**Skip the re-list verification.** Rejected as the difference between a claim and a
measurement. It is one extra LIST per deletion.

**Retain nothing at all.** Rejected: proving a deletion requires evidence. Hashes,
timestamps and counts are retained because a SHA-256 is one-way and identifies nothing,
so keeping it costs no privacy and preserves the ability to answer questions later.

**A reversible / undo window.** Rejected, and no un-delete endpoint will exist. An
endpoint that could reverse a deletion would make every deletion record a lie.

## Consequences
- **Cryptographic erasure becomes the strongest guarantee in the system.** Anything that
  survives in an unreachable copy is AES-128 ciphertext with no key anywhere. This is
  independently a reason to keep encryption in v1 even for deployments with no piracy
  concern, and it drives encryption design: one key per asset, no in-asset rotation in v1,
  and destruction rather than revocation. See ADR-0004 and [encryption.md §7](../encryption.md#7-cryptographic-erasure).
- **Two operator obligations can silently undo it** and must be documented as deployment
  requirements: database backups holding `content_keys` must not outlive the deletion SLA,
  and master-key custody must be protected accordingly.
- `deletion_records` is retained indefinitely and is deliberately excluded from retention
  configuration — a policy that erases proof-of-erasure defeats itself.
- Deletion is promoted to its own roadmap phase rather than being folded into cleanup, and
  gets the most adversarial tests in the suite.
- **This is a genuine differentiator.** No comparable open-source video project implements
  verified deletion, and for regulated media it is often the deciding requirement.
