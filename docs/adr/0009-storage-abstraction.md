# ADR-0009 — S3 API as the storage contract, behind a narrow port, with two buckets

**Status:** Accepted · 2026-09-20

## Context
The project must work against AWS S3, Cloudflare R2, MinIO and other S3-compatible stores
without special-casing any of them, and must not leak vendor semantics into application
code.

## Decision
A narrow `StorageProvider` port, implemented once against the **standard S3 API** using
`@aws-sdk/client-s3`. Operations: `put`, `get` (streaming, ranged), `head`, `delete`
(batched), `list` (paginated), `signedUrl`, and multipart.

**Production deployments use two buckets:** a source bucket and a delivery bucket.

## Alternatives considered

**Vendor SDKs per provider.** Rejected: three code paths, three sets of bugs, for an API
that is already common.

**A general filesystem abstraction (VFS).** Rejected: hides the properties that matter
here — presigned URLs, ranged reads, multipart, eventual consistency — behind a POSIX
pretence.

**One bucket with prefixes.** Simpler, and it is what the original brief sketched.
Rejected for production because a single CDN or origin-access misconfiguration then
exposes the **original file**. With two buckets, the same mistake exposes only encrypted
derivatives. This is a meaningful reduction in blast radius for near-zero cost. Defaults
to a single bucket for local development.

## Consequences
- Adding GCS or Azure means one new implementation, not changes across the codebase.
- The port deliberately excludes bucket creation, ACLs, lifecycle policies, tagging and
  versioning — those are operator concerns and including them would tie us to per-vendor
  semantics.
- The CDN's origin identity is scoped to the delivery bucket only and has **no path** to
  the source bucket.
- **Documented vendor difference that cannot be abstracted away:** R2 presigned URLs are
  not served through Cloudflare's cache and bypass custom domains. `DeliveryStrategy`
  (ADR-0005), not `StorageProvider`, is where that is handled.
