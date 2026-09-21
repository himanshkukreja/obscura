# Watermarking

## 1. What watermarking is for

**Deterrence and attribution. Not prevention.** A watermark has never stopped a copy from
being made. Its value is that a person considering one knows it will point back at them,
and that a surfaced copy can be traced to a session.

Evaluate every decision here against "does this improve attribution?" — never against
"does this stop copying?"

## 2. Obscura ships overlay watermarking only

v1 renders a **client-side overlay** in the player: a DOM/canvas layer over the `<video>`
element showing viewer identity, moving on a schedule. It is on by default and costs
nothing.

That is the whole of it. Burned-in and A/B variant watermarking were designed and then
deliberately cut; [ADR-0012](adr/0012-watermarking-overlay-only.md) records why, and
§4 below summarises it.

### What the overlay is worth

- **Captured by screen recordings and phone-camera captures**, which is the most common
  casual leak route and the one where a visible name genuinely changes behaviour.
- **Removable in seconds** by anyone who opens devtools and deletes a DOM node.
- **Entirely absent** from a file reconstructed by downloading and re-muxing segments.

We label it deterrence, in the docs and in the config comments. Anyone who needs more than
deterrence needs something Obscura does not provide.

## 3. Policy configuration

```json
{
  "enabled": true,
  "text_template": "{{user.label}} · {{asset.short_id}}",
  "opacity": 0.35,
  "font_size_vh": 2.0,
  "position": "dynamic",
  "interval_seconds": 15,
  "tiled": false
}
```

`position`: `top-left` | `top-right` | `bottom-left` | `bottom-right` | `center` |
`random` | `dynamic`.

`dynamic` cycles deterministically from a seed derived from the session ID, so a recording
can be cross-checked against the expected position schedule — a small extra attribution
signal, and the reason to prefer it over `random`:

```
0–15 s   bottom-right
15–30 s  top-left
30–45 s  center
45–60 s  bottom-left       … then repeats with a session-derived offset
```

### Template variables

`{{user.label}}`, `{{user.ref}}`, `{{session.id}}`, `{{session.short_id}}`,
`{{asset.id}}`, `{{asset.short_id}}`, `{{timestamp}}`, `{{org.name}}`.

Rendered with strict escaping and a length cap.

### Put the viewer in the watermark, not the asset

A common instinct is to watermark with the asset's own identifier — a case number, an
interview ID, a document reference. **That identifies content you already know the
identity of.** If a recording of asset 4821 leaks, "4821" tells you nothing you did not
know from the page it was viewed on.

Attribution requires **who was watching**:

```
✅  recruiter@acme.com · INT-4821        ← answers "who leaked this"
❌  INT-4821                              ← answers a question you already knew
```

Asset identity is still worth including as a secondary field — it makes a screenshot
self-describing — but it is branding, not forensics. The default template puts the viewer
first for that reason.

### Watermark text is personal data

If the template renders an email address, that address is now burned into every viewer's
screen and into any recording they make. Often that is exactly the intent. But a
pseudonym or an internal user ID provides the same attribution with less exposure, and
resolves to a person through your own records. **Prefer the shortest identifier that you
can resolve back to a human**, and note that short strings also survive a viewer's own
re-encode more legibly. See [privacy.md](privacy.md).

## 4. What was cut, and why

An earlier draft of this design shipped **per-session burned-in watermarking** as an
opt-in mode and reserved **A/B variant watermarking** for v2. Both were removed once the
real deployment profile was understood.

| | Burn-in | A/B variant |
|---|---|---|
| What it is | Re-encode the ladder per viewer with identity composited into the pixels | Pre-encode two marked variants per segment; the per-session A/B sequence encodes a viewer ID |
| Cost | One transcode per viewer; per-viewer copies in storage; startup latency | ~2× packaging and storage, once per asset; both variants stay cacheable |
| Why it was cut | Each asset has a handful of viewers ever, so the economics never arrive — and for personal-data video, scattering per-viewer copies of somebody's face makes deletion strictly harder. It converts a compliance obligation into a worse one. | It exists to solve a CDN-caching problem that does not occur at this scale, and it is worthless without a robust invisible embedder, which FFmpeg cannot provide. |

The second point on burn-in is the decisive one and is worth stating directly: **a
watermarking scheme that multiplies the number of copies of personal data is a net
negative when deletion is a legal obligation.** One canonical set of renditions is one
thing to destroy and verify.

`WatermarkProvider` remains a port (§5) so a future embedder can land without redesign,
but neither mode is on any roadmap. If your content is high-value media with a large
audience rather than personal data with a small one, A/B variant watermarking
([DASH-IF / ETSI TS 104 002](https://dashif.org/docs/IOP-Guidelines/DASH-IF-CTS-00XX-AB-Watermarking-0.9.pdf),
with [VideoSeal](https://github.com/facebookresearch/videoseal) as a candidate embedder)
is the correct design and Obscura is the wrong tool.

### Rejected outright, in any version

Embedding session identity only in metadata — a manifest comment, an MP4 atom, an HTTP
header — and calling it forensic watermarking. It survives nothing and provides no
attribution.

## 5. Provider interface

```ts
interface WatermarkProvider {
  readonly mode: 'overlay' | 'none';
  /** Per-session work. A no-op for overlay; reserved for embedders. */
  prepareSession(session: PlaybackSession, policy: WatermarkPolicy): Promise<WatermarkState>;
  /** Recover a viewer identity from a suspect file. Not implemented for overlay. */
  detect?(evidence: Readable): Promise<DetectionResult>;
}
```

The resolved watermark state is stored on the session row rather than in a separate table
— with one mode and no payload, a dedicated table would carry no information. If an
embedder is ever added, it brings its own table then.

## 6. The invariant

**The original source is never watermarked.** Marks exist only in the player, never in
stored media. The source object and its SHA-256 stay the untouched reference everything
else is verified against. CI asserts the source hash is unchanged after every processing
run.
