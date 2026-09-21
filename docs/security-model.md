# Security model

## 1. The five layers, and what each is actually worth

| Layer | Mechanism | Stops | Does not stop |
|---|---|---|---|
| L1 Hide the source | Source object private, never referenced by any browser-facing URL | Anyone getting the original file | Nothing else |
| L2 Controlled playback | Short-lived, revocable, session-bound tokens minted only after *your* app authorizes | Link sharing, replay after revocation, unauthenticated access | An authorized viewer |
| L3 Segmented delivery | HLS/CMAF ladder; no single-file artifact exists | Trivial "save video as" | Scripted reassembly |
| L4 Encryption | AES-128 segments; keys only from an authenticated live session | Reading bytes from the bucket, the CDN cache, or a captured segment without a session | An authorized viewer — the key reaches the player |
| L5 Watermarking | Viewer identity overlaid by the player | Nothing | Anything — it is deterrence, not prevention ([ADR-0012](adr/0012-watermarking-overlay-only.md)) |

**L1 and L2 carry most of the real security value.** L3–L5 are meaningful but
incremental. Any honest reading of this model puts the effort where it pays: keeping the
source private and keeping authorization short-lived and revocable.

**L4 has a second job that is easy to miss and may matter more than its first.** Because
segments are encrypted with a key Obscura controls, destroying that key renders every copy
unreadable — including copies in replicas, snapshots and edge caches that no delete call
can reach. For deployments where deletion is a legal obligation rather than housekeeping,
that property alone justifies encryption even absent any piracy concern. See
[privacy.md §5](privacy.md#5-cryptographic-erasure).

## 2. Authentication vs authorization

The service authenticates **your application**, not your users. It never learns a
password, never runs a login screen, and stores no user profile.

```
Your app                                         This service
────────                                         ────────────
knows who the user is                            knows an opaque subject_ref
decides "may this user watch asset X?"    ─────▶ mints a session for that decision
owns the consequences of that decision           enforces expiry, limits, revocation
```

`AuthorizationProvider` supports three integration modes, chosen per API client:

1. **API key** — a long random secret, stored only as a hash (Argon2id), presented as
   `Authorization: Bearer svs_<prefix>_<secret>`. The `prefix` is stored in clear for
   O(1) lookup and log correlation. Simplest; correct for server-to-server.
2. **JWT** — your existing issuer's token, validated against a configured JWKS with
   pinned issuer, audience and algorithm (asymmetric only; `alg: none` and HMAC are
   rejected outright). Use when you already have a service-to-service token.
3. **Authorization callback** — the service calls *your* endpoint with
   `{subject_ref, asset_id, context}` and mints a session only on an explicit allow. Use
   when the decision depends on state we cannot see (entitlements, seat counts,
   geography). Requires a timeout, a circuit breaker, and a documented fail-**closed**
   default.

Building a user-management platform into the core is a firm non-goal.

## 3. Playback tokens

### Structure

Two distinct objects, deliberately not one:

```
session_id      256 bits from a CSPRNG, stored in PostgreSQL.
                Long-lived relative to a token (minutes to hours).
                Revocable. The unit of audit, watermark identity and rate limiting.

playback_token  Compact signed token, EdDSA (Ed25519). Short-lived: 120-300s.
                Claims: { sid, aid, scope, exp, iat, jti, kid, [sub_hash], [cbh] }
                Stateless: validated by signature alone at the edge or in a CDN
                function, with no database round trip.
```

The session is the durable, revocable fact. The token is a brief, cheaply verifiable
capability derived from it. The player refreshes the token through the heartbeat endpoint
before it expires.

### Why this split

Stateless validation is what allows media authorization to happen at the CDN edge instead
of in our database — which is the whole reason the byte path can bypass our servers. The
cost is a **revocation latency equal to the token TTL**: a revoked session keeps working
until its current token expires. We bound this by keeping the TTL short (default 180s)
and by making the **key endpoint always check the database**. A revoked session therefore
loses access to the next content key immediately, even if a segment token is still
signature-valid. This is a deliberate, documented tradeoff, not an oversight.

For deployments that cannot tolerate even that window, a `strict_revocation` mode routes
manifest and segment authorization through the database too, at the cost of edge
statelessness.

### Binding

Optional, configurable claims that narrow what a stolen token is worth:

- `cbh` — a hash of a client-generated binding value held in the player's memory,
  returned on each heartbeat. Raises the bar from "copy a URL" to "exfiltrate runtime
  state."
- `sub_hash` — HMAC of the subject reference, so logs can correlate without storing an
  identity.
- **IP binding is available but off by default.** Mobile networks, CGNAT, corporate
  egress pools and IPv6 privacy addressing all rotate client IPs mid-session; binding to
  IP breaks legitimate playback often enough that enabling it must be a conscious choice.
  IP is not identity.

### Why tokens live in URLs

Not a preference — a constraint. Native HLS playback on Apple platforms offers **no API
to attach request headers** to manifest, key or segment fetches. Any header-based scheme
works only through hls.js and breaks on every native-HLS surface. A token in the query
string is the one mechanism that works for hls.js, native HLS, and CDN edge validation
simultaneously.

The honest cost: **tokens will appear in CDN access logs and in browser history.**
Mitigations — short TTL so a logged token is worthless within minutes; `jti` replay
tracking on the key endpoint; redaction configured at the CDN where supported; and a
documented instruction to operators that access logs containing tokens should be treated
as sensitive. We never log a full token in our own logs; `pino` redaction covers
`req.query.t`, key material, and all credential fields.

## 4. Delivery authorization: the four options

The question is where authorization is enforced and where bytes flow. The goal is
`CDN → object storage`, never `CDN → application → object storage`.

### Option A — short-lived signed URLs per object

Segment URIs in the session manifest are presigned GETs with a 2–10 minute TTL.

- **Security:** good. Scoped to one object, expires fast, storage stays private.
- **Performance:** *depends entirely on the CDN.* CloudFront excludes signature
  parameters from the cache key, so hit ratios stay high. **Cloudflare R2 presigned URLs
  are not served through the CDN cache at all** and bypass the custom domain, so on
  Cloudflare this option means no caching.
- **Operational:** manifests become non-cacheable and must be regenerated as URLs expire,
  which constrains how far ahead the player can buffer.
- **Verdict:** the best "no CDN configuration required" option; correct default for
  direct-to-storage deployments.

### Option B — signed cookies

One signature covers a path prefix; segment URLs stay stable and perfectly cacheable.

- **Security:** good, with a caveat — a cookie covering `/videos/{asset}/*` is coarser
  than a per-object grant.
- **Performance:** best available. Stable cache keys, no manifest churn.
- **Blocker:** the CDN must be on the **same registrable domain** as the page. Otherwise
  the cookie is third-party and is blocked outright by Safari's ITP and by Chrome's
  third-party cookie restrictions. Requires `SameSite=None; Secure; HttpOnly` and a
  `media.yourapp.com` style origin.
- **Verdict:** the right production choice on CloudFront when you control DNS. Not
  portable — there is no equivalent native primitive on Cloudflare.

### Option C — application proxy

The `edge` service streams bytes, honouring `Range`.

- **Security:** strongest and simplest. Every byte is authorized at request time;
  revocation is instant; storage credentials never leave the server.
- **Performance:** all video egress traverses your application. This is the expensive
  option and it does not scale economically.
- **Verdict:** the **default for local development and small self-hosted installs**, and
  the correct fallback for MinIO deployments. Never the recommendation at scale.

### Option D — opaque token in URL, validated at the edge

Stable segment URLs plus `?t=<token>`; a CDN edge function (CloudFront Function /
Lambda@Edge, Cloudflare Worker, Fastly VCL) verifies the signature and strips the
parameter from the cache key before the cache lookup.

- **Security:** equivalent to A, with tighter control — the edge can also check a small
  revocation set.
- **Performance:** excellent. Stable cache key, high hit ratio, no manifest churn.
- **Cost:** requires deploying and maintaining CDN-side code, per CDN.
- **Verdict:** **the recommended production configuration**, and the only one that works
  well on Cloudflare (where it is effectively mandatory).

### Decision

| Deployment | Strategy |
|---|---|
| Local dev / MinIO | C (`proxy`) |
| Small install, no CDN | A (`presigned`) |
| CloudFront, same-domain | B or D (`cdn-signed`) |
| Cloudflare R2 | D (`cdn-signed`, Worker) — A does not cache |
| Fastly / Akamai | D (`cdn-signed`) |

All four sit behind `DeliveryStrategy` and are selected by configuration. The session
manifest generator is the only component that knows which is active.

## 5. Content keys

- One AES-128 content key per asset by default, optionally rotated every N segments.
- Keys are generated with a CSPRNG and **never stored in object storage**. They live in
  PostgreSQL wrapped by a master key (envelope encryption, AES-256-GCM), with the master
  key supplied by `KeyProvider` from the environment, or later from KMS/Vault.
- The key endpoint returns 16 raw bytes with `Cache-Control: no-store`, a strict CORS
  allowlist, and per-session rate limiting. It checks the database on every request:
  session exists, not revoked, not expired, asset matches, token `jti` not replayed
  beyond a threshold.
- **Key rotation is a security control, not hygiene.** Rotation interval sets the
  granularity at which a revoked or expired session loses access to new content. Default:
  rotate per asset; configurable to rotate every N segments for high-value assets.
- Nothing ever logs key material. A CI test greps the log-redaction configuration against
  the list of sensitive field names to prevent regressions.

## 6. Anti-abuse

All configurable, all off-by-default except rate limiting:

| Control | Default | Notes |
|---|---|---|
| Session TTL | 4 h | Independent of token TTL |
| Token TTL | 180 s | Bounds revocation latency |
| Heartbeat interval | 60 s | Also the liveness signal |
| Max concurrent sessions per subject | unlimited | Set to 1–3 to make credential sharing painful. Enforced with a Redis counter plus a Postgres reconciliation pass. |
| Key-endpoint rate limit | 60/min/session | A player needs a handful; a scraper needs many |
| Manifest rate limit | 30/min/session | |
| Session-creation rate limit | per API client | |
| Anomaly signals | logged, not enforced | Impossible-travel, IP-count-per-session, UA changes mid-session. Emitted as events for *your* systems to act on. We do not auto-ban on signals this weak. |

Concurrent-session rejection returns a distinct, documented error so your application can
show something better than a generic failure:

```json
{ "error": "concurrent_session_limit", "limit": 2, "active": 2, "retry_after": 30 }
```

## 7. Hard rules

**Never:**
expose storage credentials to a browser · expose source object URLs · store encryption
keys in object storage · put long-lived credentials in frontend code · log playback
tokens, encryption keys, API credentials or JWT secrets · use predictable session IDs ·
use MD5 or SHA-1 for integrity · accept JWTs with `alg: none` or symmetric algorithms
from external issuers · link FFmpeg libraries into our process · fail **open** on an
authorization callback timeout.

**Always:**
SHA-256 or better · CSPRNG identifiers with ≥128 bits of entropy · TLS everywhere,
HSTS on the delivery domain · short-lived tokens · envelope-encrypted keys at rest ·
least-privilege IAM, with the CDN's origin identity scoped to the delivery bucket only ·
constant-time comparison for every secret · per-request structured logging with
redaction.

## 8. Privacy

- The service stores an **opaque `subject_ref`** supplied by your application. It never
  needs an email, a name or any other identifier. If you pass an email because it is
  convenient for watermark text, that is your choice and your data-protection
  responsibility — and the watermark template can equally render a pseudonym.
- **IP and user-agent logging is configurable and defaults to storing salted hashes, not
  raw values.** Hashes support "same client?" correlation for abuse detection without
  retaining an identifier. Raw storage is available for deployments that need it and have
  a lawful basis.
- No device fingerprinting, no geolocation, no third-party analytics, ever.
- Retention is configured explicitly and enforced by a scheduled job, not left to grow:

```yaml
privacy:
  store_ip: hashed          # none | hashed | raw
  store_user_agent: hashed
  ip_hash_salt_rotation_days: 30
retention:
  playback_sessions_days: 90
  session_events_days: 30
  audit_log_days: 365
```

Event tables are time-partitioned so retention is a partition drop rather than a
long-running delete. [privacy.md](privacy.md) carries the full data inventory (what is collected, why, where it
is stored, how long, how to erase) in a form suitable for attaching to a record of
processing, along with the verified-deletion design.
