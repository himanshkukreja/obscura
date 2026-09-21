# ADR-0012 — Overlay watermarking only; burn-in and A/B cut

**Status:** Accepted · 2026-09-21
**Supersedes:** [ADR-0006](0006-watermarking-strategy.md)

## Context
ADR-0006 shipped per-session burned-in watermarking as an opt-in mode and reserved A/B
variant watermarking for v2, on the assumption of a piracy-shaped threat: audiences of
meaningful size, content worth redistributing, and attribution as the primary lever.

The real deployment profile turned out to be different in every relevant dimension:

- **A handful of viewers per asset, ever** — not tens concurrent. The economics that make
  per-viewer encoding sensible never arrive.
- **The viewers are authorized staff**, not customers who might redistribute. Retaining a
  copy is an HR and contract problem, not a delivery-layer one.
- **The media is personal data**, and deletion is a statutory obligation rather than
  housekeeping.
- **One person is building it.**

## Decision
Ship **client-side overlay watermarking only.** Remove burned-in watermarking. Remove A/B
variant from the roadmap entirely. Keep `WatermarkProvider` as a port so an embedder could
land later, but commit to nothing.

## Rationale — the decisive argument
Burn-in does not merely fail to pay for itself here; **it actively damages the property
that matters most.**

Per-viewer derivatives mean N additional copies of somebody's face and voice scattered
across storage. Every one must be found and destroyed when that person exercises an
erasure right, and every one is an object a failed job can orphan. A watermarking scheme
that multiplies copies of personal data converts a compliance obligation into a strictly
harder compliance obligation — in exchange for attribution against a threat (T2/T6/T7)
that ranks low for this deployment and that no non-DRM scheme closes anyway.

One canonical rendition set is one thing to secure, audit and destroy. That is worth more
than a watermark nobody was going to need.

A/B variant watermarking falls to a simpler argument: it exists to reconcile per-viewer
attribution with CDN cache economics, and at this scale there are no cache economics to
reconcile. It is also worthless without a robust invisible embedder, which FFmpeg cannot
provide.

## Alternatives considered

**Keep burn-in opt-in, off by default.** Tempting — it costs nothing if unused. Rejected:
it is not free. It carries progressive-encoding machinery, storage GC for per-viewer
derivatives, job concurrency caps, startup-latency handling in the API and the player, and
a second deletion path. For a solo builder that is real weeks, and it is dead weight in the
deletion tests forever.

**Per-user rather than per-session burn-in.** The right optimisation *if* burn-in were
needed — render once per (asset, user) and reuse. It reduces the cost but not the core
objection: it still scatters copies of personal data.

**Just-in-time segment watermarking.** Bounds cost by watch time and avoids stored
derivatives, which answers the deletion objection. Rejected on complexity for one
developer, and because it routes media bytes back through the application, contradicting
ADR-0005.

**No watermarking at all.** Defensible. Kept the overlay because it is ~50 lines in the
player, costs nothing at runtime, and visibly deters the most common casual leak.

## Consequences
- Every viewer receives **identical bytes**, so segments stay fully CDN-cacheable and there
  is exactly one media copy per asset to secure, audit and delete.
- Sessions are available immediately; no `preparing` state, no latency budget.
- `watermark_assignments` is dropped; the rendered overlay string lives on the session row.
- **Attribution is weak, and documented as such.** The overlay is removable in seconds via
  devtools and absent entirely from a segment reassembly. Anyone needing real forensic
  attribution needs something Obscura does not provide, and [watermarking.md §4](../watermarking.md#4-what-was-cut-and-why)
  says so and names the correct alternatives.
- The default template is corrected to identify **the viewer** rather than the asset.
  Watermarking content with its own identifier answers a question you already knew the
  answer to.
