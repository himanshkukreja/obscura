# Obscura vs Bunny Stream

Bunny Stream is the strongest cost competitor, so it deserves a direct comparison rather
than a row in a table. Checked against vendor documentation in September 2026.

**Short version:** compared like for like — both running on Bunny's infrastructure —
they cost roughly the same. The "Bunny is 6× cheaper" figure compares Obscura on AWS
against Bunny on Bunny, which is a comparison of storage vendors, not of products.

---

## 1. Where does the video actually live?

You asked the right question first. Every hosted platform stores your media on **their**
infrastructure. None of them can read your bucket.

| | Media stored on | Data residency | Bring your own storage |
|---|---|---|---|
| **Obscura** | **Your bucket** — S3, R2, MinIO, any S3 API | Wherever you put it | N/A, it is all yours |
| Bunny Stream | Bunny Storage (edge-replicated, 14+ regions) | EU regions selectable; edge PoPs are global | **No** |
| Mux | Mux infrastructure | Limited control | **No** |
| Cloudflare Stream | Cloudflare network | Global | **No** |

Bunny is the best of the three on residency — a Slovenian company, GDPR-native, master files
held in EU regions when you select them, with routing policies to keep traffic on European
edge nodes. If EU residency is your concern rather than custody, Bunny handles it well.

But "stored in the EU by a GDPR-compliant processor" and "stored in an account you control"
are different claims, and only one of them is answerable without trusting a third party.

**The practical consequence:** with any hosted platform you upload a *copy* of every
recording. The original still sits in your bucket — you need it for AI processing,
re-encoding, or simply as the record — so you end up with **two copies of the same personal
data in two organisations**, and you pay cloud egress every month to keep the second one
fed.

## 2. Feature by feature

### Streaming — Bunny wins

| | Obscura | Bunny Stream |
|---|---|---|
| Adaptive bitrate HLS | Yes | Yes |
| Global CDN | **No** — object-storage origin | **Yes**, 100+ PoPs, geo-replicated |
| Hosted player | Reference implementation (source) | Yes, polished |
| Thumbnails / preview sprites | **No** | Yes |
| Analytics + heatmaps | **No** | Yes |
| Live streaming | **No** — permanent non-goal | Yes |
| Automatic captions | **No** — import yours | Yes |
| Resumable uploads (TUS) | Multipart only | Yes |
| Codecs | H.264 | H.264 |

Not close. Bunny is a finished product; Obscura is a delivery primitive.

### Protection — mixed, and more even than it looks

| | Obscura | Bunny Stream |
|---|---|---|
| Encrypted segments | AES-128 HLS | MediaCage Basic — **per-play-session content key** |
| Studio DRM | **No** | **Yes**, Enterprise tier (Widevine + FairPlay) |
| Token auth / expiring URLs | Yes, Ed25519, ~180 s | Yes |
| Referrer / domain lock | **No** | Yes |
| Geo restriction | **No** | Yes |
| Concurrent-session limits | **Yes, built in** | **No** |
| Revocation | **Immediate** — key endpoint checks the DB every fetch | Token expiry |
| Per-viewer watermark | **Yes**, session-seeded position | Static watermark only |

Bunny's MediaCage Basic rotates a content key **per play session**, which is finer-grained
than Obscura's per-asset key, and it is free. Credit where due. Their Enterprise tier adds
real Widevine and FairPlay, which Obscura will never have.

Obscura is ahead on exactly two things here: revocation that takes effect immediately
rather than at token expiry, and concurrent-session limits as a first-class feature.

### Accountability — Bunny cannot compete, structurally

| | Obscura | Bunny Stream |
|---|---|---|
| Signed integrity manifest | **Yes** — Ed25519 over a Merkle root | No |
| Per-segment inclusion proofs | **Yes** | No |
| Publicly verifiable signing keys | **Yes** — JWKS endpoint | No |
| Verified deletion, storage re-checked empty | **Yes** | No |
| Signed deletion record outliving the asset | **Yes** | No |
| **Cryptographic erasure — key destroyed** | **Yes** | **No** |
| Copies of your data outside your control | **Zero** | One full copy |
| Access log designed as a privacy artifact | **Yes** | Analytics |
| Salted-hash IP / user agent | **Yes**, configurable | No |
| Retention enforcement | **Yes**, scheduled | Manual |

The key-destruction row is not a feature gap Bunny could close. **They hold the keys**,
because they operate the encryption. Any copy surviving in a replica or edge cache is
readable by them, and "we deleted it" is a claim about their internal processes that you
can neither verify nor evidence onward.

## 3. Cost, compared like for like

The 6× figure compares Obscura-on-AWS with Bunny-on-Bunny. Put both on the same
infrastructure and it collapses.

Marginal cost of adding streaming, 12-minute interviews, 2 views each, 12-month retention:

| Scenario | Obscura on S3 | Obscura on R2 | Obscura on R2 + Bunny CDN | **Obscura on Bunny Storage** | **Bunny Stream** |
|---|---|---|---|---|---|
| A 500/mo | $240 | $185 | $187 | **$159** | **$28** |
| B 5,000/mo | $1,111 | $559 | $584 | **$307** | **$281** |
| C 50,000/mo | $10,823 | $5,303 | $5,554 | **$2,782** | **$2,810** |

At 5,000 interviews/month the difference is **$26**. At 50,000, **Obscura is $29 cheaper**.

The mechanism is simple. Storage and delivery cost the same in both columns — same vendor,
same rates. Obscura adds compute ($143–$1,144). Bunny Stream adds **S3 egress to hand them
a copy every month** ($12 / $117 / $1,173), which grows with volume until it exceeds the
compute.

At small scale Bunny Stream is genuinely much cheaper, because $143 of compute is large
relative to everything else. That advantage disappears by ~5,000 interviews/month.

## 4. The combination worth considering

Obscura's storage layer is the S3 API, and **Bunny Storage exposes an S3-compatible API**.
Bunny CDN can also pull from a private S3 origin using S3 authentication, and supports token
authentication on delivery URLs.

So the architecture is available in principle:

```
Obscura (your EC2)  ──writes──▶  Bunny Storage (S3 API)  ──origin──▶  Bunny CDN  ──▶  viewer
     │                                                                      ▲
     └── signed integrity manifests, verified deletion, key destruction ────┘
         token validated at the edge
```

You would get Bunny's storage price, Bunny's CDN and egress price, and Bunny's global PoPs,
while keeping custody, integrity attestation and cryptographic erasure.

**This is untested and two things stand between it and working:**

1. **`cdn_signed` is not implemented.** It exists as a port with nothing behind it. Bunny's
   token authentication is well documented, so this is a bounded piece of work, but it is
   work.
2. **Obscura has never run against Bunny Storage.** The S3 operations it requires are:

   | Operation | Used for | Failure if missing |
   |---|---|---|
   | `PutObject` / `GetObject` / `HeadObject` | Everything | Total |
   | **`ListObjectsV2`** (with pagination) | **Verified deletion enumerates storage rather than trusting the database** | Deletion cannot find orphans — the central guarantee breaks |
   | `DeleteObjects` (batch) | Deletion | Degrades to per-object; slower, still correct |
   | Presigned `GET` / `PUT` | Upload targets, presigned delivery | Upload flow breaks |
   | Multipart (`Create`/`UploadPart`/`Complete`/`Abort`) | Large sources | Large uploads fail |

   `ListObjectsV2` is the one that matters. If Bunny Storage's S3 API does not paginate it
   faithfully, verified deletion silently stops being verified — which would be worse than
   not offering it.

Testing this is an afternoon: point `S3_ENDPOINT` at Bunny Storage, run the existing
integration suite, and specifically watch the deletion test that plants an orphaned object.

## 5. Choosing

**Bunny Stream** if you want a finished product and custody is not a requirement. Global
CDN, DRM tier, analytics, live, captions, somebody else's on-call. Much cheaper below a few
thousand videos a month. For most video on the internet this is the right answer.

**Obscura** if the media is personal data you are accountable for. You give up the CDN, DRM,
analytics, live and captions. You get: media that never leaves your account, signed
integrity manifests, verified deletion, and key destruction that makes unreachable copies
inert. At meaningful volume it costs the same.

**Obscura on Bunny Storage + Bunny CDN**, if the compatibility holds, is the interesting
answer: Bunny's economics and reach with Obscura's accountability. Worth an afternoon of
testing before betting on it.

Numbers behind this: [scaling-and-cost.md](scaling-and-cost.md).
Wider comparison: [feature-comparison.md](feature-comparison.md).
