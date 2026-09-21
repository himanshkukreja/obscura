# ADR-0003 — HLS with CMAF/fMP4 segments; DASH deferred

**Status:** Accepted · 2026-09-20

## Context
We must choose a streaming protocol and a segment container. The options are HLS or DASH
(or both), with MPEG-TS or fragmented MP4 (CMAF) segments.

## Decision
**HLS as the v1 protocol, with CMAF/fMP4 segments.** DASH manifest generation is deferred
but architecturally reserved.

## Alternatives considered

**DASH first.** Cleaner specification, better DRM and multi-period support. Rejected: no
native support on Apple platforms, so an HLS path would be required anyway. Shipping DASH
first means shipping two protocols first.

**HLS with MPEG-TS segments.** The historically safest choice, and the only container that
works with SAMPLE-AES in hls.js today. Rejected: ~10% packetisation overhead, no path to
CENC/DRM, and — decisively — TS segments cannot be reused by a DASH manifest, so choosing
TS means re-encoding everything to add DASH later.

**Both, from day one.** Rejected as premature. Almost no v1 user needs DASH.

## Consequences
- One encode produces segments that both an HLS playlist and a future DASH MPD can
  reference. Adding DASH becomes an MPD generator, not a re-encode.
- CMAF is the container CENC and every DRM system assume, so ADR-0004's migration path
  stays open.
- Requires iOS 10+ for native HLS, which is not a real constraint in 2026.
- **Open risk:** `METHOD=AES-128` with fMP4 on Apple's *native* HLS is unverified. If it
  proves unsupported, the choice is a TS+AES-128 fallback ladder for non-MSE clients, or
  declaring those clients unsupported. This is the first item in the Phase 1
  compatibility matrix, deliberately scheduled before the pipeline is built out.
