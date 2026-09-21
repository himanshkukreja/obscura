# Phase 0 research

Everything below was checked in September 2026. License and status claims were verified
against the GitHub API or the project's own licence file at that time; re-verify before
relying on any of them legally.

---

## 1. Projects named in the brief

| Project | License | Status | Verdict |
|---|---|---|---|
| [sanjanaynvsdl/videostreaming-api](https://github.com/sanjanaynvsdl/videostreaming-api) | **None** | TypeScript, 0 stars | **Do not copy any code.** |
| [Raqibreyaz/Video-Streaming](https://github.com/Raqibreyaz/Video-Streaming) | **None** | TypeScript, 1 star | **Do not copy any code.** |
| [beautifulruby/hls](https://github.com/beautifulruby/hls) | **None** | Ruby, 16 stars | **Do not copy any code.** |
| [Eyevinn/ffmpeg-s3](https://github.com/Eyevinn/ffmpeg-s3) | MIT | TypeScript, small | Safe to reuse with attribution. |

> **This is the single most important finding of the licence review.** Three of the four
> suggested references publish **no licence at all**. Under the Berne Convention, absent
> a licence the work is "all rights reserved" — GitHub's public-repo terms permit viewing
> and forking *on GitHub*, and nothing more. We may read them to understand the shape of
> the problem. We may not copy code, configuration, FFmpeg argument strings copied
> verbatim as a block, or distinctive file layouts into this project. If a contributor
> submits code derived from them, it must be rejected.

What they are actually useful for: confirming the conventional ingest→FFmpeg→HLS→S3 flow
and showing the common failure modes (synchronous transcoding in the request path,
public buckets, no keyframe alignment, no integrity story). They are shape references,
not implementation references.

## 2. Projects worth studying seriously

| Project | License | Why it matters to us |
|---|---|---|
| [hls.js](https://github.com/video-dev/hls.js) | Apache-2.0 | Our player dependency. The custom loader API (`loader`, `pLoader`, `fLoader`, and the `keyLoader` path) is exactly how we attach tokens and control key fetching. Its `LoaderContext.type` distinguishes `manifest`/`level`/`key`/`fragment`. Also the reference for what encryption is *actually* supported in browsers. |
| [Shaka Player](https://github.com/shaka-project/shaka-player) | Apache-2.0 | The alternative player. Better DASH and EME/DRM story, heavier. The player to move to if we add real DRM. |
| [Shaka Packager](https://github.com/shaka-project/shaka-packager) | BSD-3-Clause | The industry-standard packager. Native CMAF and `cbcs`/`cenc`. Its documented weakness for our purposes: plain full-segment `METHOD=AES-128` HLS is poorly supported (see issues #714, #776, #1587 — the last describing non-16-byte-aligned byte ranges breaking AES-CBC). Candidate second packaging backend behind a `Packager` port if/when we move to CENC. |
| [Bento4](https://github.com/axiomatic-systems/Bento4) | **GPLv2 / commercial dual-license** | Excellent MP4/CMAF tooling. The GPL arm makes it unsuitable for us to depend on or bundle in a permissively licensed project without careful analysis. Avoid for v1. |
| [VideoSeal](https://github.com/facebookresearch/videoseal) | MIT | The realistic open-source path to *invisible* forensic watermarking. Neural, temporally consistent, JND-masked; 256-bit model (v1.0, 2025) and a 1024-bit ChunkySeal variant. PyTorch — hence the Python-worker seam in [ADR-0002](adr/0002-language-and-runtime.md). |
| [DASH-IF / ETSI TS 104 002](https://dashif.org/docs/IOP-Guidelines/DASH-IF-CTS-00XX-AB-Watermarking-0.9.pdf) | Spec | The standard for A/B variant forensic watermarking. Defines how a packager emits two variants per segment and how the edge selects per session. This is the design we should grow into, not invent. |
| [aws-samples/amazon-cloudfront-protecting-hls-manifest-with-signed-url](https://github.com/aws-samples/amazon-cloudfront-protecting-hls-manifest-with-signed-url) | MIT-0 | A working reference for injecting signed URLs into manifests at the CDN edge with Lambda@Edge. Directly relevant to our `cdn-signed` delivery strategy. |
| [BullMQ](https://github.com/taskforcesh/bullmq) | MIT | Our job queue. |

**Intentionally not studied as architectural references:** PeerTube (AGPL, federation-first,
entirely different problem), Owncast (live streaming), Jellyfin/Plex (media libraries with
on-the-fly transcoding for personal use). Their concerns do not overlap with ours enough
to justify the licence exposure of reading their code closely.

## 3. Standards research

### HLS

- **RFC 8216** is the published baseline (Informational, August 2017).
- The living specification is **draft-pantos-hls-rfc8216bis**; revision **-22** (1 May
  2026) describes protocol version 13 and obsoletes RFC 8216 if approved. Apple's
  *HTTP Live Streaming* authoring documentation and the annual WWDC "What's new in HLS"
  notes are, in practice, the normative source for what Apple devices actually accept.
- **Implication:** cite RFC 8216 for stable concepts, but implement against 8216bis-22
  and Apple's authoring requirements, and pin the exact draft revision in our docs so
  readers know what we built against.

### Containers: MPEG-TS vs fMP4/CMAF

CMAF (ISO/IEC 23000-19) fragmented MP4 is the right default:

- One set of media segments can serve both an HLS playlist and a DASH MPD — one encode,
  two manifests. MPEG-TS cannot do this.
- Lower overhead than TS (no 188-byte packetisation tax).
- It is the container all modern DRM and CENC encryption assume.
- Cost: no support in Apple's pre-iOS 10 native HLS, which is irrelevant in 2026.

### Encryption standards

Summarised here; the full comparison with recommendations is in
[encryption.md](encryption.md).

| Scheme | What it is | Browser reality (Sept 2026) |
|---|---|---|
| `METHOD=AES-128` | AES-128-CBC over the **whole segment** | Supported by hls.js with both TS and fMP4 (hls.js issue #2259, closed 2020). Apple's native HLS historically pairs AES-128 with TS; **AES-128 + fMP4 on native HLS must be empirically verified** before we depend on it. |
| `METHOD=SAMPLE-AES` | AES-CBC over **media samples only**, headers left clear | hls.js supports `identity`-format SAMPLE-AES keys for MPEG-2 TS. For fMP4 it requires an EME/ClearKey session, and hls.js's ClearKey path is incomplete — the key system is recognised but there is no supported way to supply key ID/value pairs (issues #1491, #2901, #5092). **Not viable for v1.** |
| `cbcs` / `cenc` (CENC, ISO/IEC 23001-7) | Sample-level encryption in CMAF, the DRM substrate | Requires EME. With ClearKey it is not reliably usable in hls.js today; with Widevine/FairPlay/PlayReady it needs licence servers and, for the useful security levels, vendor agreements. |
| Full DRM | CDM-held keys, hardware paths, HDCP | Out of scope for v1 by design; see [ADR-0004](adr/0004-encryption-aes128-not-drm.md). |

**Conclusion: AES-128 over CMAF, delivered to hls.js, is the only option in 2026 that is
standards-based, self-hostable, free, and actually works in browsers.** It is also
strictly weaker than DRM and we must say so everywhere.

### Browser and player reality

- **ManagedMediaSource** (Apple, iOS 17.1, November 2023) finally allows MSE-based
  players on iPhone Safari. hls.js supports it from 1.5 (2024). This is what makes a
  single hls.js code path viable across platforms — but it establishes **iOS 17.1 as our
  floor** for the full-featured path.
- **Native HLS cannot set request headers.** On any native-HLS playback surface
  (older iOS Safari, tvOS, some Android WebViews) there is no API to attach an
  `Authorization` header to manifest, key or segment requests. This single constraint
  forces URL-bound tokens as the primary authorization mechanism. It is the most
  consequential compatibility finding in this document.

### CDN capabilities

- **CloudFront** has first-class signed URLs *and* signed cookies, with modern key
  groups. Signed cookies are the documented best practice for HLS precisely because one
  signature covers a whole path prefix of segments, keeping the cache key stable.
  Signature parameters are not part of the cache key, so signed URLs also cache well.
- **Cloudflare R2** presigned URLs **are not served through the CDN cache layer** and
  cannot be used with a custom domain — they expose the native R2 endpoint. The
  supported pattern is a custom domain plus a **Worker** (or WAF/Snippets rules) that
  validates a token before the cache. So on Cloudflare, "presigned R2 URL" and "cached
  by the CDN" are mutually exclusive, and the Worker path is not optional.
- **Fastly** and Akamai provide equivalent edge-token validation through VCL/EdgeWorkers
  and Token Auth respectively.

**Implication:** signed-URL semantics are *not* portable across CDNs. `DeliveryStrategy`
must be a real abstraction with per-CDN implementations and per-CDN example
configurations, not a single "signed URL" code path with a template.

## 4. Watermarking research

Three techniques, in ascending order of cost and strength:

1. **Client-side overlay.** A DOM/canvas layer over the `<video>` element. Zero server
   cost, fully cacheable. It *is* captured by screen recording, which is its entire
   value. It is removed in seconds by anyone using devtools, and it is absent entirely if
   segments are downloaded and re-muxed. Deterrence only.
2. **Per-session burned-in.** Re-encode the ladder per session with the identity
   composited in. Genuinely present in the pixels. Costs a full transcode per viewer and
   destroys CDN cacheability, because every viewer's bytes are unique. Viable only for
   small audiences and high-value content.
3. **A/B variant (DASH-IF / ETSI TS 104 002).** Pre-encode two near-identical variants of
   every segment, each carrying a different embedded mark. Each session receives a
   specific A/B sequence, so the sequence itself encodes a session identifier. Storage
   and packaging cost roughly double **once**, not per viewer, and both variants remain
   cacheable. This is how the commercial industry (AWS Elemental MediaPackage, Irdeto,
   Unified Streaming, NAGRA) solves the cacheability/attribution conflict.

A/B watermarking is only as good as the embedder that makes A differ from B: the
difference must be imperceptible to viewers and recoverable from a re-encoded,
re-scaled, screen-recorded copy. That is a hard signal-processing problem, and it is
where **VideoSeal** (MIT) becomes relevant. Nothing in FFmpeg's stock filter set produces
a robust invisible mark.

**Therefore:** v1 ships (1) and optional (2), and builds the data model and delivery path
so (3) slots in without redesign. We will not ship a metadata field labelled "forensic
watermark" and pretend it is one.

## 5. Integrity and provenance research

- Plain SHA-256 over each artifact answers "are these the exact bytes we produced?"
- A **Merkle tree** over the segment hashes adds something a flat list cannot: an
  O(log n) proof that one specific segment belongs to a signed asset, without
  transferring the whole hash list. For a 2-hour asset at 4-second segments across four
  renditions that is ~7,200 hashes; a single proof is ~13 hashes. This is what makes
  spot-verification of a suspect file practical.
- A **signature** over the Merkle root is what turns integrity into *provenance*: it
  attests that **our** pipeline, holding **our** key, produced these bytes from a source
  with a stated hash. Hashes alone attest to nothing about origin.
- **C2PA** (Coalition for Content Provenance and Authenticity) is the real standard for
  media provenance and is worth aligning with later. It is not a fit for v1: its tooling
  targets capture-to-publish workflows and camera/editor attestation, not encrypted
  segment delivery.
- **Perceptual hashing** (pHash, TMK+PDQF) is a *different tool for a different question*
  — "is this visually the same content?" — and is the only thing that survives
  re-encoding. Explicitly out of scope for v1, named here so nobody expects SHA-256 to do
  its job. See [integrity.md](integrity.md#2-what-a-hash-does-not-prove).

## 6. License analysis

### Recommended project licence: **Apache-2.0**

- Permissive, so companies can adopt it without legal review friction — which is the
  point of releasing it.
- Includes an **express patent grant** and a patent-retaliation clause. MIT does not.
  This matters unusually much here: video coding and forensic watermarking are dense
  patent thickets (the A/B watermarking technique itself is covered by granted US patents
  such as 11,889,164 and 12,267,567). Contributors granting patent rights explicitly is
  worth the slightly longer licence text.
- Apache-2.0 is one-way compatible with GPLv3, so GPL projects can still use us.
- **Rejected:** MIT (no patent grant), AGPL (would block the commercial self-hosting
  adoption that is the whole goal), BSL/source-available (not open source).

### FFmpeg: the licence question that actually matters

FFmpeg is LGPL-2.1+ at its core, but building with `--enable-gpl` — which is required for
**libx264** and **libx265**, i.e. for any practical H.264/HEVC encoder — makes the
resulting binary **GPLv2+**. Nearly every prebuilt FFmpeg, including Homebrew's and the
common Docker images, is a GPL build.

Consequences for us:

1. **Our source code is unaffected.** We invoke `ffmpeg` as a **separate process** over a
   command line — no linking, no shared address space. This is the well-established
   boundary that keeps our Apache-2.0 code free of GPL obligations. We must therefore
   *never* link an FFmpeg library (`libavcodec` etc.) into the API or worker process, and
   should say so in `CONTRIBUTING.md` as a hard rule, because a well-meaning PR swapping
   the subprocess for a native binding would silently change the project's licence
   position.
2. **Our Docker images are affected.** An image that bundles a GPL FFmpeg build is a
   distribution of that GPL binary, and carries GPLv2 obligations for *that component*
   (offer of corresponding source, licence text included). The pragmatic, standard
   handling: base the worker image on a distro package of FFmpeg, ship the licence texts
   in the image, and document where to obtain the corresponding source. We will state
   this plainly in `docker/README.md` rather than quietly shipping it.
3. **x264/x265 patent licensing** is a separate matter from copyright. Commercial users
   encoding H.264/HEVC at scale may have obligations to MPEG-LA/Access Advance and, for
   x264/x265 binaries specifically, to their vendors. We document this and do not advise
   on it.

*This is an engineering summary, not legal advice. Organisations shipping this
commercially should have counsel review the FFmpeg build and codec licensing.*

### Third-party dependency policy

Every runtime dependency must be MIT, Apache-2.0, BSD or ISC. Copyleft dependencies are
allowed only as separate processes or container images, never as linked libraries. CI
enforces this with an automated licence check, and `docs/third-party.md` records, for
each external project we learned from or reuse: repository, licence, what we learned,
what code (if any) is reused, and compatibility with Apache-2.0.

## 7. Open questions — status after implementation

### ✅ ANSWERED, the hard way: FFmpeg cannot encrypt fMP4 at all

This was not on the original list, and it invalidated the assumed implementation of
[ADR-0004](adr/0004-encryption-aes128-not-drm.md). FFmpeg's HLS muxer supports encryption
for **MPEG-TS only**:

| container | encryption | result |
|---|---|---|
| fmp4 | none | works |
| mpegts | AES-128 | works |
| **fmp4** | **AES-128** | `Not yet implemented in FFmpeg, patches welcome` |

Obscura therefore packages unencrypted and applies AES-128-CBC + PKCS#7 itself — the
construction the spec defines. See [ADR-0013](adr/0013-encrypt-after-packaging.md). It
turned out to be an improvement rather than a workaround: key material never touches disk.

*Verified against FFmpeg 8.0. Re-check on future releases.*

### Still open — needs real devices, not a specification

1. Does `METHOD=AES-128` with fMP4/CMAF segments play on **Safari native HLS** (macOS and
   iOS), or only through hls.js? Confirmed working through hls.js with our own encryption;
   the native path is untested. If native support is absent, the fallback for non-MSE
   clients must be decided (TS+AES-128, or declaring those clients unsupported).
2. Do **encrypted WebVTT** subtitle segments work across hls.js and Safari? Subtitles
   currently ship unencrypted but token-authorized — a deliberate, documented reduction.
3. What is the real playback-start latency cost of a per-session generated manifest plus
   a key round-trip, on a cold CDN cache?
4. Does CloudFront correctly exclude our token query parameter from the cache key, and
   does the Cloudflare Worker path reach acceptable cache-hit ratios?
5. How does hls.js behave when the key endpoint returns 401 mid-playback (revocation)?
   The player handles `data.response.code === 401 | 403` as "session ended"; the exact
   hls.js error shape still needs confirming against a live revocation in a browser.

## Sources

- [draft-pantos-hls-rfc8216bis-22](https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis-22) · [What's new in HLS, WWDC 2026](https://developer.apple.com/streaming/Whats-new-HLS.pdf)
- [hls.js](https://github.com/video-dev/hls.js) · [API docs](https://github.com/video-dev/hls.js/blob/master/docs/API.md) · issues [#1491](https://github.com/video-dev/hls.js/issues/1491), [#2259](https://github.com/video-dev/hls.js/issues/2259), [#2901](https://github.com/video-dev/hls.js/issues/2901), [#5092](https://github.com/video-dev/hls.js/issues/5092), [#7256](https://github.com/video-dev/hls.js/issues/7256)
- [Shaka Packager](https://github.com/shaka-project/shaka-packager) issues [#714](https://github.com/google/shaka-packager/issues/714), [#776](https://github.com/google/shaka-packager/issues/776), [#1587](https://github.com/shaka-project/shaka-packager/issues/1587)
- [VideoSeal](https://github.com/facebookresearch/videoseal) · [Video Seal paper](https://arxiv.org/pdf/2412.09492)
- [DASH-IF A/B Watermarking](https://dashif.org/docs/IOP-Guidelines/DASH-IF-CTS-00XX-AB-Watermarking-0.9.pdf) · [AWS Elemental MediaPackage A/B watermarking](https://docs.aws.amazon.com/mediapackage/latest/userguide/ab-watermarking.html) · [Forensic watermarking and A/B streaming](https://www.forasoft.com/learn/video-streaming/articles-streaming/forensic-watermarking-ab-streaming)
- [CloudFront: serve private content](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html) · [signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html) · [aws-samples signed-URL manifest protection](https://github.com/aws-samples/amazon-cloudfront-protecting-hls-manifest-with-signed-url)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [Protect an R2 bucket with Cloudflare Access](https://developers.cloudflare.com/r2/tutorials/cloudflare-access/) · [Control cache access with WAF and Snippets](https://developers.cloudflare.com/cache/interaction-cloudflare-products/waf-snippets/)
- [FFmpeg legal](https://www.ffmpeg.org/legal.html) · [FFmpeg LICENSE.md](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)
- [ManagedMediaSource on iPhone with hls.js](https://dev.to/masonwritescode/playing-hls-through-managed-media-source-on-iphone-with-hlsjs-3cn8) · [iOS and Safari: the native player you can't escape](https://www.forasoft.com/learn/video-streaming/articles-streaming/ios-safari-native-player)
