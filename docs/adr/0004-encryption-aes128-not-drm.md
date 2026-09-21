# ADR-0004 — AES-128 HLS encryption in v1; no DRM in the core

**Status:** Accepted · 2026-09-20

## Context
Media segments should not be usable if obtained outside an authorized session. The
candidates are `METHOD=AES-128`, `SAMPLE-AES`, CENC `cbcs`/`cenc` with ClearKey, and full
DRM.

## Decision
**AES-128 full-segment encryption over CMAF**, with keys served from a session-scoped,
database-checked endpoint. No DRM in the core, ever — only as an optional `DrmProvider`
integration later.

## Alternatives considered

**SAMPLE-AES.** hls.js supports `identity`-format SAMPLE-AES for MPEG-2 TS only; for fMP4
it needs EME ClearKey, and hls.js's ClearKey path is incomplete (issues #1491, #2901,
#5092). Adopting it would force a return to MPEG-TS and forfeit ADR-0003.

**CENC `cbcs` + EME ClearKey.** The right long-term substrate and the step that makes DRM
a key-management change rather than a re-encode. Not reliably usable through hls.js today;
would make Shaka Player the required client. Scheduled for v2.

**Widevine / FairPlay / PlayReady.** The only thing that meaningfully raises the cost for
an authorized viewer. Rejected for the core: requires vendor licence servers,
certificates and commercial agreements, which would make the project non-self-hostable —
contradicting its reason for existing.

**No encryption.** Rejected: leaves segments readable from any cache or leaked bucket, and
gives up the key endpoint as a revocation choke point.

## Consequences
- Works today across hls.js on all modern browsers including iOS 17.1+.
- FFmpeg produces it natively; no extra packager dependency.
- The key endpoint becomes a second, independently revocable authorization gate — the one
  request a player cannot cache. Key rotation interval therefore becomes a security
  tunable rather than hygiene.
- **The key is exposed to the page.** An authorized viewer can read it in devtools. This
  is inherent to non-DRM HLS and must be stated in the README, the threat model and the
  encryption doc. Schemes that "hide" the key from the network tab by encrypting it to a
  page-held public key add steps, not security, since that private key is also in the
  page.
- Whole-segment encryption forecloses byte-range/partial-segment optimisations.
