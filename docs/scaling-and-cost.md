# Scaling and cost

Every throughput number here was measured by running the real pipeline, not estimated.
Prices are list rates as of September 2026 in `ap-south-1` — **verify before budgeting**,
they move.

---

## 1. What was measured

FFmpeg 8.0, `libx264 -preset veryfast`, 4-second CMAF segments, on an Apple M3 Pro
(5 performance + 6 efficiency cores). Measured in **CPU-seconds**, not wall time, so it
extrapolates across machines.

| Source | Ladder | CPU-seconds per minute of source |
|---|---|---|
| 720p webcam | 720p / 480p / 360p | **80** |
| 1080p | 1080p / 720p / 480p / 360p | **222** |

Per rung, on 120 seconds of 1080p:

| Rung | Wall | CPU | Parallelism |
|---|---|---|---|
| 1080p | 22.8 s | 192.7 s | 8.4× |
| 720p | 13.9 s | 122.4 s | 8.8× |
| 480p | 9.1 s | 73.6 s | 8.1× |
| 360p | 6.2 s | 55.3 s | 9.0× |

Two things follow. x264 parallelises well (~8–9× across threads), so wall time drops nearly
linearly with cores. And **the top rung dominates** — 1080p alone is 43% of the total, which
is why the no-upscaling rule is a cost control as much as a quality one.

> Apple Silicon and Xeon differ in instructions-per-cycle, and the M3 Pro's efficiency cores
> burn more CPU-seconds for the same work than its performance cores. Treat these as
> ±30%. Benchmark on your own instance:
>
> ```bash
> /usr/bin/time -p ffmpeg -i sample.mp4 -vf scale=1280:720 -c:v libx264 \
>   -preset veryfast -b:v 2800k -f null - 2>&1 | grep -E 'user|sys'
> ```

## 2. Capacity per instance

At 70% utilisation, transcode only:

| Instance | vCPU | $/month | 720p video/month | 12-min interviews | 1080p video/month |
|---|---|---|---|---|---|
| `c7i.large` | 2 | $72 | 768 h | 3,840 | 276 h |
| **`c7i.xlarge`** | **4** | **$143** | **1,535 h** | **7,675** | **552 h** |
| `c7i.2xlarge` | 8 | $286 | 3,070 h | 15,349 | 1,105 h |
| `c7i.4xlarge` | 16 | $572 | 6,140 h | 30,698 | 2,210 h |

**Transcoding is not the bottleneck people expect.** A single $143/month instance absorbs
roughly 7,700 twelve-minute interviews per month. If you are below that, compute is a
rounding error and you should stop thinking about it.

Never use burstable (`t3`/`t4g`). You get ~20% of a vCPU as baseline and burn credits above
it; a sustained transcode drains the balance and then throttles the entire instance.

## 3. What each minute of video costs in bytes

Measured end to end on a real 13.9-minute 720p interview, encoded by the shipped ladder
and read back out of the delivery bucket:

| | 720p workload | 1080p workload |
|---|---|---|
| All renditions | **13 MB/min** | 26 MB/min † |
| Source retained | 18 MB/min | 44 MB/min |
| **Stored total** | **31 MB/min** | **70 MB/min** |
| Delivered, top rung | 7 MB/min watched | 13 MB/min watched † |

† 720p is measured; the 1080p row is the same ratio applied to the previous figures, not a
separate measurement. Treat it as an estimate.

**These numbers changed by a factor of three when encoding became quality-targeted.** The
figures here were 39 MB/min of renditions and 21 MB/min delivered, because each rung was
asked for a fixed bitrate and spent it whether the picture needed it or not. The same
interview now stores 180 MB instead of 535 MB — and at SSIM 0.988 against the source, the
difference is not visible. See [architecture.md](architecture.md#transcode-decisions).

**Source retention is now optional.** Nothing reads the source once an asset is READY —
not playback, not deletion, not `obscura verify`, which re-hashes only the delivery bucket.
A lifecycle rule expiring it removes 18 of those 31 MB/min. The only thing it costs is
re-encoding without re-uploading, which matters when you change the ladder. Keep it if you
have no other copy; expire it if the original already lives somewhere you control.

## 4. Total cost, three scenarios

12-minute interviews, 2 full-length views each, 12-month retention, 720p sources.

Read this table with a caveat: it puts Obscura on AWS and each hosted platform on its own
infrastructure, so it measures **storage vendors as much as products**. §4b and §4c correct
for that.

| Scenario | Ingest/mo | Library | **Obscura (S3)** | Cloudflare Stream | Mux | Bunny Stream |
|---|---|---|---|---|---|---|
| **A** 500 interviews/mo | 6,000 min | 2.1 TB | **$211** | $372 | $849 | $23 |
| **B** 5,000/mo | 60,000 min | 21.3 TB | **$784** | $3,720 | $8,490 | $228 |
| **C** 50,000/mo | 600,000 min | 213 TB | **$7,805** | $37,200 | $84,900 | $2,281 |

Obscura at scenario B breaks down as:

```
compute   1x c7i.xlarge      $   143     (1,332 CPU-hours of transcode)
storage   21.3 TB            $   545     ← 69% of the bill
egress    0.84 TB            $    92
disk      40 GB gp3          $     4
```

Expiring the retained source (§3) takes scenario B's library to 8.9 TB and the bill to
about $467. Transitioning renditions older than 30 days to a colder class takes it lower
again — most interviews are watched in their first fortnight and never afterwards.

**Storage dominates, and it is not close.** Compute is 10% of the bill at any realistic
scale. Every instinct to optimise the transcode is misdirected effort.

## 4b. The fairer comparison: marginal cost

The table above charges Obscura for storing the original files. That overstates it. If you
already keep source video in S3 — and most adopters do, because they need it for
processing, re-encoding, or simply as the record — that cost is **sunk and identical in
every option**. It is not part of the decision.

Baseline you pay regardless, 720p sources, 12-month retention:

| Scenario | Originals in S3 | Cost |
|---|---|---|
| A 500/mo | 1.3 TB | $32/mo |
| B 5,000/mo | 12.6 TB | $322/mo |
| C 50,000/mo | 125.7 TB | $3,219/mo |

**Marginal cost of adding secure streaming on top of that:**

| Scenario | Obscura (S3) | **Obscura (R2)** | Bunny | Cloudflare Stream | Mux |
|---|---|---|---|---|---|
| A 500/mo | $179 | **$161** | $28 | $384 | $861 |
| B 5,000/mo | $468 | **$284** | $281 | $3,837 | $8,607 |
| C 50,000/mo | $4,641 | **$2,805** | $2,810 | $38,373 | $86,073 |

This changes the picture materially:

- **vs Mux: 30× cheaper** on R2 at scenario B
- **vs Cloudflare Stream: 13.5× cheaper**
- **vs Bunny: level.** On R2 at scenario B the two are within 1%, and at scenario C
  Obscura is marginally cheaper. That is the headline change from quality-targeted
  encoding: the one comparison Obscura used to lose on price it now draws.

### The cost that appears on nobody's pricing page

A hosted platform cannot read your bucket. You upload a **copy** of every new recording,
and pulling it out of S3 is egress you pay every month, forever:

| Scenario | Monthly S3 egress just to hand over a copy |
|---|---|
| A | $12 |
| B | $117 |
| C | $1,173 |

That is included in the hosted columns above. It never appears in a vendor comparison
because it is charged by AWS, not by them.

### The other thing a copy means

| Scenario | Candidate video duplicated into a third party's infrastructure |
|---|---|
| A | 2.7 TB |
| B | 27.1 TB |
| C | 271 TB |

For personal data under erasure obligations, that is not a cost line. It is a second place
you must be able to evidence deletion from, using whatever API they give you and whatever
assurances they are willing to put in writing.

## 4c. Like for like: same infrastructure, both products

Obscura's storage layer is the S3 API, and Bunny Storage exposes an S3-compatible API. Put
both products on the same vendor and the storage-price difference disappears, leaving only
the products:

| Scenario | **Obscura on Bunny Storage** | **Bunny Stream** | Difference |
|---|---|---|---|
| A 500/mo | $159 | $28 | +$131 |
| B 5,000/mo | $307 | $281 | **+$26** |
| C 50,000/mo | $2,782 | $2,810 | **−$29** |

At 5,000 interviews a month the difference is $26. At 50,000 **Obscura is cheaper**, because
a hosted platform makes you pay cloud egress to hand it a copy of every recording, every
month, and that grows with volume until it exceeds Obscura's fixed compute.

Below roughly 2,000 interviews a month Bunny Stream is genuinely cheaper, and the reason is
mundane: $143 of compute is large relative to a small library. That advantage is real and it
disappears as you grow.

**So cost is not the deciding factor at any scale you are likely to care about.** It is a
wash at moderate volume and favours Obscura at high volume. The decision is about
capability.

## 5. What you are actually choosing between

Obscura is not a streaming platform competing on streaming. It is a **delivery and custody
layer** for video you are accountable for, and the comparison only makes sense in those
terms.

### What Obscura provides that no hosted platform does

| | Obscura | Mux | Cloudflare | Bunny |
|---|---|---|---|---|
| Media never leaves your account | **Yes** | No | No | No |
| Signed integrity manifest (Ed25519 over a Merkle root) | **Yes** | No | No | No |
| Per-segment inclusion proofs, ~400 bytes | **Yes** | No | No | No |
| Publicly verifiable signing keys | **Yes** | No | No | No |
| Verified deletion — storage enumerated, re-checked empty | **Yes** | No | No | No |
| Signed deletion record that outlives the asset | **Yes** | No | No | No |
| **Cryptographic erasure — the key destroyed** | **Yes** | No | No | No |
| Immediate revocation, not token expiry | **Yes** | No | No | No |
| Concurrent-session limits built in | **Yes** | No | No | No |
| Retention enforcement built in | **Yes** | No | No | No |
| Salted-hash IP / user agent, configurable | **Yes** | No | No | No |
| Zero additional sub-processors | **Yes** | No | No | No |
| Auditable implementation, Apache-2.0 | **Yes** | No | No | No |
| Storage portability — S3, R2, MinIO, B2 | **Yes** | No | No | No |

The key-destruction row is the one that cannot be closed by a competitor's roadmap. **They
hold the keys**, because they operate the encryption. Any copy surviving in a replica,
snapshot or edge cache remains readable by them, and "we deleted it" is a claim about
internal process that you can neither verify nor pass on to an auditor. When Obscura
destroys a content key, every unreachable copy becomes permanently inert, and there is a
signed record saying so.

For video that is personal data — candidate recordings, medical consultations, legal
proceedings, internal investigations — that list is not a set of nice-to-haves. It is the
difference between being able to answer a regulator and not.

### What the hosted platforms provide that Obscura does not

Stated plainly, because pretending otherwise would undermine everything above:

- **Global CDN.** All three. Obscura serves from object storage; `cdn_signed` is a port with
  nothing behind it. Fine at a handful of viewers per asset, a real constraint above that.
- **Studio DRM.** Mux and Bunny Enterprise. Obscura will not have it in the core, by design.
- **Automatic captions.** Cloudflare (12 languages) and Mux. Obscura imports a transcript
  you already have.
- **Per-title encoding and modern codecs.** Mux does content-aware encoding and AV1/HEVC,
  and genuinely beats a fixed H.264 ladder on bytes per unit of quality.
- **Thumbnails, sprite sheets, clipping, live, playback analytics, mobile SDKs.** Various.
- **Somebody else's on-call rotation.** All of them. This is the real product.

### The scope question

If you are streaming marketing videos, course content, or anything where nobody will ever
ask where the file lives, a hosted platform is a better product and you should use one.
Obscura is not trying to win that comparison.

If the video is personal data with erasure obligations attached, Obscura is the only option
on this page that lets you answer the questions that follow — at roughly the same cost.

## 6. The levers that actually matter

### Storage backend — bigger effect than anything else

Scenario B, identical workload, only the bucket changes:

| Backend | Storage $/GB | Egress $/GB | Storage | Egress | Total/mo |
|---|---|---|---|---|---|
| AWS S3 Standard | 0.0250 | 0.1093 | $545 | $92 | **$784** |
| S3 + Intelligent-Tiering | 0.0125 | 0.1093 | $272 | $92 | **$512** |
| **Cloudflare R2** | 0.0150 | **0.00** | $327 | $0 | **$474** |
| Backblaze B2 + Cloudflare | 0.0060 | 0.00 | $131 | $0 | **$278** |

R2 and B2 have **zero egress**. Obscura's storage layer is the S3 API, so this is a config
change, not a migration — `S3_ENDPOINT` and two bucket names. Moving to R2 cuts the bill
40% with no code change and no loss of custody.

Egress matters less than it used to: quality-targeted encoding cut the delivered bytes
along with the stored ones, so zero-egress backends now win mostly on storage price.

One caveat already documented: R2 presigned URLs are not served through Cloudflare's cache
and bypass custom domains, so on R2 you want the `cdn_signed` strategy with a Worker —
which is not implemented yet. Until it is, R2 works with `presigned` but without CDN
caching.

### Retention — the biggest lever you control

Scenario B on R2:

| Retention | Library | Storage | Total/mo | vs 12 months |
|---|---|---|---|---|
| 1 month | 1.8 TB | $27 | $174 | −63% |
| 3 months | 5.3 TB | $82 | $229 | −52% |
| 6 months | 10.6 TB | $163 | $310 | −34% |
| **12 months** | 21.3 TB | $327 | **$474** | — |
| 24 months | 42.6 TB | $654 | $801 | +69% |
| 60 months | 106 TB | $1,635 | $1,782 | +276% |

Obscura already enforces retention (`asset_default_ttl_days`, plus the scheduled job) and
deletion is verified rather than best-effort. **Retention is both your largest cost lever
and your data-protection posture, and they point the same way** — which is unusually
convenient and worth exploiting.

### Dropping the source after processing

The original is ~31% of stored bytes. Deleting it after `READY` cuts storage by a third.

Do not do this casually. You lose the ability to re-encode when the ladder changes, and the
source hash stops having anything behind it. A better middle path is S3 Glacier Instant
Retrieval for `source/` ($0.004/GB, millisecond retrieval) — 84% cheaper, still there when
you need it. Obscura does not manage storage classes; add a bucket lifecycle rule on the
`source/` prefix.

### Spot instances for workers

Workers are stateless and jobs are resumable by design, so spot is a natural fit —
roughly 70% off compute. Compute is only ~10% of the bill, so this saves less than it feels
like it should.

## 7. Where the architecture scales, and where it does not

### Scales horizontally today

- **Workers.** Share nothing but Redis, Postgres and object storage. `--scale worker=N`.
- **API and edge.** Stateless. Segment tokens validate by signature alone, so no database
  round trip on the hot path.
- **Object storage.** S3's problem, not yours.

### Will need attention

| Component | Comfortable to | Then what |
|---|---|---|
| PostgreSQL (single instance) | ~10M assets, ~100M session events | Managed RDS with read replicas; event tables are already monthly-partitioned |
| Redis | Millions of jobs/day | Only queue and rate-limit state; cluster if it ever matters |
| `session_events` | Partition drops handle it | Already time-partitioned, retention enforced |
| Edge manifest generation | Thousands/sec per instance | Stateless; add instances |

### Fixed while writing this document

`finalize` used to re-download **every segment** from storage to compute its hash — hashes
the rendition job had already calculated and discarded. For a one-hour asset across four
rungs that was ~2.4 GB re-read and several thousand extra S3 requests **per asset**, making
finalize the most expensive step in the pipeline at exactly the point where it should be
cheap.

The rendition job now writes a small hash sidecar per rendition, and finalize reads that.
Cost went from O(bytes) to O(renditions): one small GET instead of one GET plus one HEAD per
segment. At scenario C that is roughly 14 TB/month of pointless reads removed.

### Known limits

- **No CDN.** Every byte comes from object storage. Fine for few-viewers-per-asset; if one
  asset ever goes to thousands of concurrent viewers, you need `cdn_signed` implemented.
- **Per-asset concurrency is 1.** Rungs for one asset run in parallel, but a single very
  long video cannot be split across machines. A 4-hour recording takes ~5.3 CPU-hours
  regardless of fleet size. Chunked parallel encoding would fix it; not built.
- **No per-title encoding.** A fixed ladder spends the same bits on a static talking head
  as on high-motion content. Mux and Cloudflare do content-aware encoding and genuinely
  beat us on bytes-per-quality.

## 8. Recommendations

**At your scale today** (scenario A–B): one `c7i.xlarge`, S3 or R2, 12-month retention.
$211–$784/month on S3, $174–$474 on R2. Compute is noise; do not optimise it.

**Move to R2 when storage passes ~10 TB.** Zero egress and lower per-GB. Config change only.

**Set a retention policy before the library grows.** Going from 12 months to 3 cuts the
bill 60% and is a better data-protection position. Retrofitting retention onto an existing
library means a lot of deletion jobs at once.

**Consider a hosted platform instead if any of these become true:**

- One asset regularly draws thousands of concurrent viewers (you need a real CDN)
- You need live streaming (explicitly out of scope)
- You need studio DRM (Widevine/FairPlay, not in the core by design)
- Nobody has time to operate it — a hosted platform's real product is somebody else's
  on-call rotation, and that is worth paying for
- Nobody has ever asked where the recordings live, and nobody plausibly will

---

### Assumptions

List prices, September 2026, `ap-south-1`. Excludes: engineering time to build and operate,
on-call, monitoring, backup storage, NAT/data-transfer between AZs, and support plans.
Hosted-platform figures use published list rates and ignore volume discounts, which Mux
documents at 15–35% for committed usage.

Sources: [Mux pricing](https://www.mux.com/pricing) ·
[Cloudflare Stream pricing](https://developers.cloudflare.com/stream/pricing/) ·
[Bunny Stream](https://bunny.net/stream/) · AWS on-demand pricing.
