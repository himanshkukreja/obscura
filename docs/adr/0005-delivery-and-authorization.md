# ADR-0005 — URL-bound tokens, per-session generated manifests, pluggable delivery

**Status:** Accepted · 2026-09-20

## Context
Manifests, segments and keys all need authorization. The goal is `CDN → object storage`,
not `CDN → application → object storage`. Signed-URL and signed-cookie semantics differ
substantially between CDNs, and Apple's native HLS cannot attach request headers to any
media request.

## Decision
Three decisions together:

1. **Authorization travels in the URL** (`?t=<token>`), not in a header.
2. **Manifests are generated per session**, never stored per session. The edge rewrites
   segment URIs for the active delivery strategy and points `#EXT-X-KEY` at a
   session-scoped key endpoint.
3. **`DeliveryStrategy` is a real port** with `proxy`, `presigned` and `cdn-signed`
   implementations, the last having per-CDN variants.

Tokens are short-lived (default 180 s) Ed25519-signed capabilities derived from a
long-lived, revocable session record.

## Alternatives considered

**`Authorization` headers via hls.js custom loaders.** Cleaner, keeps tokens out of logs.
Rejected: fails on every native-HLS surface, and fails at CDN edge validation. It remains
available as optional extra hardening on the key endpoint, not as the mechanism.

**One long-lived presigned URL per asset.** Rejected outright — it is the problem this
project exists to fix.

**Signed cookies only.** Best cache behaviour on CloudFront, but requires the CDN to be on
the same registrable domain as the page (otherwise Safari ITP and Chrome's third-party
cookie restrictions block it), and has no portable equivalent on Cloudflare. Supported as
one `cdn-signed` variant, not as the model.

**Always proxy bytes through the application.** Simplest and most secure; every byte
authorized at request time, instant revocation. Rejected as the default because video
egress through the application does not scale economically. Kept as the local-development
and small-install default.

**Stateful token validation on every request.** Rejected as the default because it forces
every segment request through our database, defeating edge authorization. Available as
`strict_revocation` mode.

## Consequences
- **Tokens will appear in CDN access logs and browser history.** Bounded by a short TTL,
  `jti` replay tracking, redaction where the CDN supports it, and an explicit operator
  warning. Never logged by us.
- **Revocation latency equals the token TTL for segments** — but is **immediate at the key
  endpoint**, which always checks the database. A revoked session loses the next content
  key at once. This is the designed compensation for stateless edge validation.
- Per-session manifests mean stored artifacts are identical for every viewer: hashable,
  cacheable, and free of per-user data.
- Signed-URL behaviour is not portable. Each CDN needs its own implementation and its own
  worked example. On Cloudflare the Worker path is mandatory, because R2 presigned URLs
  are not served through the cache and bypass custom domains.
