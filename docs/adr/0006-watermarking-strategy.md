# ADR-0006 — Overlay and burn-in in v1; A/B variant architecture reserved

**Status:** **Superseded by [ADR-0012](0012-watermarking-overlay-only.md)** · 2026-09-21
*(accepted 2026-09-20, superseded the following day once the real deployment profile was
known — see 0012 for what changed and why)*

## Context
Watermarking exists for attribution, not prevention. The approaches differ enormously in
cost, and per-viewer uniqueness is in direct conflict with CDN caching.

## Decision
v1 ships **client-side overlay** (default, on) and **per-session burned-in** (opt-in,
off). The `WatermarkProvider` port and `watermark_assignments` table are designed for
**A/B variant** watermarking, which is deferred to v2.

`watermark_assignments` rows are written for every session from v1, even when the mode is
`overlay` and the payload is empty, so the A/B and detection paths do not require a schema
migration or a change to the session lifecycle.

## Alternatives considered

**Burn-in as the default.** Rejected: one full transcode per viewer, plus startup latency,
plus zero CDN cache value. Correct for a 40-seat cohort, wrong for anything larger.

**A/B variant in v1.** The right architecture, but it is only as good as the embedder that
makes A differ from B imperceptibly yet recoverably after re-encoding. FFmpeg has nothing
that does this. Shipping A/B with a crude embedder would be watermarking theatre.

**Metadata-only marking.** Rejected outright. It survives nothing and provides no
attribution. Calling it forensic protection is the specific dishonesty this project is
supposed to avoid.

**Just-in-time per-segment watermarking.** A genuine middle ground — cost bounded by watch
time rather than asset length. Rejected for v1 because it puts bytes back through our
service, contradicting ADR-0005. Worth measuring in v2.

## Consequences
- v1 gives universal, free deterrence plus a real forensic option for high-value content.
- Overlay's weakness is documented plainly: removable in seconds via devtools, and absent
  entirely from a file reassembled from segments.
- Burn-in's cost is surfaced through the API (`preparing: true` with an estimate), so
  calling applications can show a real state instead of appearing broken.
- **Invariant:** the original source is never watermarked. The worker treats the source
  prefix as read-only and CI asserts the source hash is unchanged after every run.
