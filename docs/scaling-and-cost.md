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

| | 720p workload | 1080p workload |
|---|---|---|
| All renditions | 39 MB/min | 77 MB/min |
| Source retained | 18 MB/min | 44 MB/min |
| **Stored total** | **58 MB/min** | **121 MB/min** |
| Delivered, top rung | 21 MB/min watched | 38 MB/min watched |

## 4. Total cost, three scenarios

12-minute interviews, 2 full-length views each, 12-month retention, 720p sources.

| Scenario | Ingest/mo | Library | **Obscura (S3)** | Cloudflare Stream | Mux | Bunny Stream |
|---|---|---|---|---|---|---|
| **A** 500 interviews/mo | 6,000 min | 4.0 TB | **$276** | $372 | $849 | $23 |
| **B** 5,000/mo | 60,000 min | 39.6 TB | **$1,436** | $3,720 | $8,490 | $228 |
| **C** 50,000/mo | 600,000 min | 396 TB | **$14,045** | $37,200 | $84,900 | $2,281 |

Obscura at scenario B breaks down as:

```
compute   1x c7i.xlarge      $   143     (1,332 CPU-hours of transcode)
storage   39.6 TB            $ 1,015     ← 71% of the bill
egress    2.45 TB            $   275
disk      40 GB gp3          $     4
```

**Storage dominates, and it is not close.** Compute is 10% of the bill at any realistic
scale. Every instinct to optimise the transcode is misdirected effort.

## 5. The honest part: Obscura is not the cheapest option

**Bunny Stream undercuts self-hosting at every scale** — roughly 6× cheaper than Obscura on
AWS. It bills per GB rather than per minute, includes transcoding free, and its CDN egress
is $0.01/GB against S3's $0.109/GB. If cost were the only consideration, you would use
Bunny and not read the rest of this document.

What you give up with any hosted platform:

| | Obscura | Hosted platform |
|---|---|---|
| Where the media lives | Your bucket, your account | Their infrastructure |
| Verified deletion with a signed record | Yes | Deletion API, no proof |
| Cryptographic erasure on delete | Yes — key destroyed | Not offered |
| Signed integrity manifests | Yes | No |
| Sub-processor paperwork | None | One more processor in your DPA |
| Session revocation semantics | You define them | Theirs |
| Cost trajectory | Storage prices, which fall | Their pricing, which they set |

For interview recordings — personal data, statutory erasure rights, an auditor who may
ask — those rows are the reason to self-host. **Obscura is not the cheapest way to stream
video. It is the cheapest way to stream video you remain accountable for.**

If your content is marketing clips, Bunny is the right answer and this project is overkill.

## 6. The levers that actually matter

### Storage backend — bigger effect than anything else

Scenario B, identical workload, only the bucket changes:

| Backend | Storage $/GB | Egress $/GB | Storage | Egress | Total/mo |
|---|---|---|---|---|---|
| AWS S3 Standard | 0.0250 | 0.1093 | $1,015 | $275 | **$1,436** |
| S3 + Intelligent-Tiering | 0.0125 | 0.1093 | $508 | $275 | **$929** |
| **Cloudflare R2** | 0.0150 | **0.00** | $609 | $0 | **$756** |
| Backblaze B2 + Cloudflare | 0.0060 | 0.00 | $244 | $0 | **$390** |

R2 and B2 have **zero egress**. Obscura's storage layer is the S3 API, so this is a config
change, not a migration — `S3_ENDPOINT` and two bucket names. Moving to R2 cuts the bill
47% with no code change and no loss of custody.

One caveat already documented: R2 presigned URLs are not served through Cloudflare's cache
and bypass custom domains, so on R2 you want the `cdn_signed` strategy with a Worker —
which is not implemented yet. Until it is, R2 works with `presigned` but without CDN
caching.

### Retention — the biggest lever you control

Scenario B on R2:

| Retention | Library | Storage | Total/mo | vs 12 months |
|---|---|---|---|---|
| 1 month | 3.3 TB | $51 | $197 | −74% |
| 3 months | 9.9 TB | $152 | $299 | −60% |
| 6 months | 19.8 TB | $305 | $451 | −40% |
| **12 months** | 39.6 TB | $609 | **$756** | — |
| 24 months | 79.3 TB | $1,218 | $1,365 | +81% |
| 60 months | 198 TB | $3,045 | $3,192 | +322% |

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
$276–$1,436/month on S3, $197–$756 on R2. Compute is noise; do not optimise it.

**Move to R2 when storage passes ~10 TB.** Zero egress and lower per-GB. Config change only.

**Set a retention policy before the library grows.** Going from 12 months to 3 cuts the
bill 60% and is a better data-protection position. Retrofitting retention onto an existing
library means a lot of deletion jobs at once.

**Revisit if any of these become true** — they are the conditions under which a hosted
platform wins:

- One asset regularly draws thousands of concurrent viewers (you need a real CDN)
- You need live streaming (explicitly out of scope)
- You need studio DRM (Widevine/FairPlay, not in the core by design)
- Nobody has time to operate it — a hosted platform's real product is somebody else's
  on-call rotation, and that is worth paying for

---

### Assumptions

List prices, September 2026, `ap-south-1`. Excludes: engineering time to build and operate,
on-call, monitoring, backup storage, NAT/data-transfer between AZs, and support plans.
Hosted-platform figures use published list rates and ignore volume discounts, which Mux
documents at 15–35% for committed usage.

Sources: [Mux pricing](https://www.mux.com/pricing) ·
[Cloudflare Stream pricing](https://developers.cloudflare.com/stream/pricing/) ·
[Bunny Stream](https://bunny.net/stream/) · AWS on-demand pricing.
