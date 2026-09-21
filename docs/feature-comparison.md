# Feature comparison

Obscura against the hosted platforms it is most often weighed against. Vendor capabilities
were checked against their own documentation in September 2026 — **re-verify before
deciding**, these move quickly.

**Obscura is a narrower product with a different purpose.** It does not compete on
streaming features and does not try to. What it provides — and no platform on this page
does — is custody, cryptographic attestation of what was produced, and provable destruction.
Where those matter, nothing else here is a substitute at any price. Where they do not, the
hosted platforms are better products.

---

## 1. Content protection

| | Obscura | Mux | Cloudflare Stream | Bunny Stream |
|---|---|---|---|---|
| Transport encryption | HLS AES-128 | AES-128 + CENC | encrypted, tokenised | MediaCage Basic |
| Studio DRM (Widevine / FairPlay / PlayReady) | **No — by design** | **Yes**, GA, incl. offline | **No** | Enterprise tier only |
| Key delivery | Session-scoped endpoint, DB-checked every fetch | Licence server | Managed | Per-session content key |
| Revocation latency | **Immediate** at the key endpoint | Token expiry | Token expiry | Token expiry |
| Short-lived playback tokens | Yes, Ed25519, ~180 s | Yes, JWT | Yes | Yes |
| Concurrent-session limits | **Yes, built in** | Build it yourself | Build it yourself | No |
| Domain allowlist | No | Yes | Yes | Yes (referrer) |
| Geo / IP restriction | No | Yes | Yes | Yes |

**Where Obscura is genuinely better:** revocation. Everyone else revokes by letting a token
expire. Obscura's key endpoint checks the database on every fetch, so a revoked session
loses access to the next content key *immediately* — even while its segment token is still
signature-valid. That is a deliberate split between stateless edge validation and a
stateful choke point, and it is the difference between "access ends within 3 minutes" and
"access ends now."

**Where Obscura is worse, and it is not close:** no studio DRM. If you ever need Widevine or
FairPlay — licensed content, a customer contract demanding it — Mux has it and Obscura does
not, by an architectural decision ([ADR-0004](adr/0004-encryption-aes128-not-drm.md))
taken to keep the project self-hostable. Adding it means a licence server and vendor
agreements, which is a different kind of product.

Also missing: domain allowlisting and geo restriction. Both are easy to add and both are
real gaps today.

## 2. Watermarking

This is the feature most often misunderstood, so it is worth being precise.

| | Obscura | Mux | Cloudflare Stream | Bunny Stream |
|---|---|---|---|---|
| Burned-in logo / branding | **No** | Yes | Yes (VOD only) | Yes |
| Per-viewer identity in the player | **Yes, built in** | Build it yourself | Build it yourself | No |
| Session-seeded moving position | **Yes** | No | No | No |
| Burned-in per-viewer identity | No — [deliberately cut](adr/0012-watermarking-overlay-only.md) | **No** | No | No |
| Forensic / invisible (A/B variant) | No | **No** | No | No |

**Nobody in this tier does forensic watermarking.** Mux's own documentation states it
plainly: visible watermarking is supported, per-user and forensic watermarking are not, and
per-user marks have to be overlaid on the player — "easier to bypass since they're not baked
into the video." That is exactly Obscura's position, stated in exactly the same terms.

So on per-viewer attribution, Obscura and the hosted platforms are at **parity in strength**
and Obscura is ahead on convenience: identity, template, opacity and a session-seeded
position schedule come out of the playback-session response rather than being something you
build.

Real forensic watermarking means A/B variant delivery with a robust invisible embedder —
Irdeto, NAGRA, Verimatrix territory, enterprise pricing. Obscura's architecture reserves
space for it; none of these platforms offer it either.

**Where Obscura loses:** no burned-in branding watermark. If you want your logo in the
corner of every rendition, all three competitors do it and Obscura does not. It is a small
feature to add — a filter in the ladder — and it is genuinely absent today.

## 3. Integrity, deletion and custody

This is the part where the comparison stops being close.

| | Obscura | Mux | Cloudflare Stream | Bunny Stream |
|---|---|---|---|---|
| Signed integrity manifest | **Yes** — Ed25519 over a Merkle root | No | No | No |
| Per-segment inclusion proofs | **Yes** — ~400 bytes | No | No | No |
| Publicly verifiable signing keys | **Yes** — JWKS endpoint | No | No | No |
| Verified deletion (storage enumerated, re-checked empty) | **Yes** | No | No | No |
| Signed deletion record surviving the asset | **Yes** | No | No | No |
| Cryptographic erasure on delete | **Yes** — key destroyed | **No** | **No** | **No** |
| Media stays in your account | **Yes** | No | No | No |
| Extra sub-processor in your DPA | **None** | Yes | Yes | Yes |
| Retention enforcement | **Yes**, scheduled | Manual | Manual | Manual |
| Access log — who watched what | **Yes** | Analytics | Analytics | Analytics |
| IP / user-agent stored as salted hashes | **Yes**, configurable | No | No | No |

Every platform has a delete API. **None of them can destroy the key**, because they hold
it. That is not a gap in their products; it is a structural consequence of somebody else
operating the encryption. When Obscura destroys a content key, any copy that survived in a
replica, snapshot or edge cache you could never have reached becomes permanently
unreadable. No hosted platform can make that claim about its own infrastructure.

Likewise, nobody else signs an attestation that storage was enumerated, deleted, and
re-checked empty. If an auditor or a candidate asks you to evidence erasure, "we called
their delete endpoint" and "here is a signed record with an object count and a verification
flag" are different answers.

**These three rows are the entire reason to run Obscura.** If none of them matter for your
content, the hosted platforms are better products.

## 4. Media pipeline

| | Obscura | Mux | Cloudflare Stream | Bunny Stream |
|---|---|---|---|---|
| Adaptive bitrate HLS | Yes | Yes | Yes | Yes |
| CMAF / fMP4 segments | Yes | Yes | Yes | Yes |
| DASH | No — segments are reusable | Yes | Yes | Yes |
| Codecs | H.264 | H.264, **HEVC, AV1** | H.264 only | H.264 |
| Per-title / content-aware encoding | **No** | **Yes** | No | No |
| Never upscales | Yes | Yes | Yes | Yes |
| Thumbnails / storyboards | **No** | Yes | Yes | Yes |
| Clipping / trimming | No | Yes | Yes | Yes |
| Automatic captions | **No** — bring your own | Yes | **Yes**, 12 languages | Yes |
| Subtitle upload + transcript import | Yes | Yes | Yes | Yes |
| Live streaming | **No — permanent non-goal** | Yes | Yes | Yes |
| Multi-audio tracks | No | Yes | Yes | Yes |

**Where Obscura loses, plainly:** no thumbnails, no per-title encoding, no automatic
captions, no live, H.264 only. Mux's per-title encoding and AV1 support genuinely beat us
on bytes-per-unit-of-quality — a fixed ladder spends the same bits on a static talking head
as on high-motion content.

Cloudflare's AI captions in 12 languages is a real feature Obscura does not have and will
not build. Obscura accepts a transcript you already have
(`POST /assets/{id}/subtitles/import`) which suits a platform that already transcribes, and
is useless if you do not.

## 5. Delivery and operations

| | Obscura | Mux | Cloudflare Stream | Bunny Stream |
|---|---|---|---|---|
| Global CDN | **No** — object storage origin | Yes | Yes | **Yes**, 100+ PoPs |
| Signed delivery URLs | Yes | Yes | Yes | Yes |
| QoE / playback analytics | **No** | **Yes**, best in class | Yes | Yes, with heatmaps |
| Hosted player | Reference only (source) | Yes, Mux Player | Yes | Yes |
| Mobile SDKs | **No** | Yes | No | No |
| Uptime SLA | Yours | Theirs | Theirs | Theirs |
| On-call | **Yours** | Theirs | Theirs | Theirs |

**The CDN gap is the most consequential.** Every byte comes from your bucket. That is fine
at a handful of viewers per asset — which is the profile Obscura was designed for — and
becomes a real problem the moment one asset draws thousands of concurrent viewers. The
`cdn_signed` strategy exists as a port with nothing behind it.

Mux's analytics is a product in its own right. Obscura deliberately does not track playback
position, because that is behavioural profiling, and estimates watch time from heartbeat
counts instead. That is the right call for personal data and the wrong one if you want to
know where viewers drop off.

## 6. Everything else

| | Obscura | Hosted platforms |
|---|---|---|
| Licence | Apache-2.0, source available | Proprietary |
| Self-hostable | Yes | No |
| Storage portability | S3, R2, MinIO, B2 — config change | None |
| Vendor lock-in | None | Migration project |
| Cost trajectory | Storage prices, which fall | Their pricing |
| Pricing model | Infrastructure at cost | Per minute or per GB |
| Auditable implementation | Yes — read it | No |
| CLI | Yes | Partial |
| Time to first stream | Hours | Minutes |

---

## Scorecard

**Only Obscura offers:**

1. Signed integrity manifests with per-segment proofs
2. Verified deletion with a signed record that outlives the asset
3. Cryptographic erasure — destroying the key, not just the object
4. Media that never leaves your account
5. Immediate revocation rather than waiting for a token to expire
6. Built-in concurrent-session limits and retention enforcement

**Hosted platforms are better at:** studio DRM (Mux), global CDN (all), automatic captions
(Cloudflare, Mux), per-title encoding and modern codecs (Mux), thumbnails and clipping
(all), live (all), analytics (all), and not being your on-call rotation (all).

**Neither side offers:** true forensic watermarking. That remains an enterprise-vendor
capability.

## Choosing

Use **Obscura** when the media is personal data you are accountable for, when you must
evidence deletion, when custody or data residency is contractual, or when audience per
asset is small enough that a CDN is not the binding constraint.

Use **Mux** when you need studio DRM, deep playback analytics, or the best encoding
efficiency, and the per-minute price is acceptable.

Use **Cloudflare Stream** when you want simple pricing and automatic captions and do not
need DRM.

Use **Bunny Stream** when cost is the dominant concern and custody is not — it is
substantially cheaper than everything here, including self-hosting.

See [scaling-and-cost.md](scaling-and-cost.md) for the numbers behind that last point.
