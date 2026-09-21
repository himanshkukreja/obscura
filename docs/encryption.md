# Encryption

## 1. The distinction that matters most

**HLS encryption is not DRM.** They solve different problems and the difference is not a
matter of strength.

| | HLS encryption (AES-128, SAMPLE-AES) | DRM (Widevine, FairPlay, PlayReady) |
|---|---|---|
| Where the key ends up | In the player's memory — in JavaScript, readable by the user | Inside a Content Decryption Module; never exposed to page JavaScript |
| What it protects against | Anyone **without** a valid session | Also, partially, the **authorized viewer** |
| Output protection (HDCP) | None | Available at higher security levels |
| Self-hostable | Yes, entirely | No — requires vendor licence servers and agreements |
| Cost | Free | Per-stream or per-device fees, plus certification |

An AES-128 HLS key is delivered to the player over HTTPS and is visible in the browser's
network tab. Any viewer who can watch can read the key. This is inherent to the design,
not a bug in it, and schemes that "hide" the key by encrypting it with a page-held public
key (see hls.js issue #7256) only add steps, because the page's private key is also in the
page. Only a CDM that the user's browser refuses to introspect changes the picture.

**What AES-128 genuinely buys us:**

- Segments sitting in a CDN cache, a corporate proxy, an ISP cache or a leaked delivery
  bucket are unusable on their own.
- Keys become a **second, independently revocable authorization gate** — the one request
  the player must make and cannot cache. Revocation takes effect there immediately, even
  when segment authorization is stateless at the edge.
- It raises the cost of casual extraction from "right-click a `.ts` URL" to "write a
  script that tracks key rotation."

**And one thing that is easy to miss:** because Obscura owns the content key, it can
*destroy* it. Every segment anywhere in the world — in a bucket replica, a snapshot, a CDN
edge, a backup nobody remembers — becomes permanently unreadable the moment that key row
is gone. For deployments where deletion is a legal obligation, **this is the single
strongest property encryption provides here**, and it would be reason enough to encrypt
even with no piracy concern at all. See §7.

That is worth having. It is not worth misrepresenting.

## 2. Options compared

### AES-128 (`METHOD=AES-128`) — **chosen for v1**

AES-128-CBC over the entire segment, key referenced by `#EXT-X-KEY` in the media
playlist.

- **Support:** hls.js handles it with both MPEG-TS and fMP4 (issue #2259, closed 2020).
  Native Apple HLS pairs it with TS historically; **AES-128 + fMP4 on native HLS is an
  open verification item** (see [research.md §7](research.md#7-open-questions-to-settle-empirically-in-phase-1)).
- **Pros:** simplest correct option; FFmpeg produces it natively via `-hls_key_info_file`;
  key delivery is a plain authenticated HTTP endpoint we fully control; no EME, no CDM,
  no vendor.
- **Cons:** whole-segment encryption means the decryptor must receive a complete,
  16-byte-aligned segment before parsing — this is why byte-range/partial-segment tricks
  break under AES-128 (Shaka Packager issue #1587). Slightly more CPU on the client than
  sample-level encryption. Keys are fully exposed to the page.
- **Verdict:** the only option that is standards-based, self-hostable, free, and actually
  works in browsers today.

### SAMPLE-AES — rejected for v1

Encrypts media samples only, leaving container headers in the clear.

- **Support:** hls.js supports `identity`-format SAMPLE-AES for **MPEG-2 TS only**. For
  fMP4 it needs an EME ClearKey session, and hls.js's ClearKey path is incomplete: the key
  system is recognised but there is no supported way to supply key ID/value pairs, so no
  licence or session path exists (issues #1491, #2901, #5092).
- **Verdict:** adopting it would force us back to MPEG-TS, giving up CMAF and the
  single-encode/dual-manifest property, in exchange for a marginal CPU saving. Rejected.

### CENC `cbcs` / `cenc` (ISO/IEC 23001-7) — the future path, not v1

Sample-level encryption in CMAF; the substrate every DRM system uses. `cbcs` (AES-CBC) is
what FairPlay requires; `cenc` (AES-CTR) is the historical Widevine/PlayReady mode. A
`cenc` file cannot be decrypted by FairPlay — different cipher mode, not a configuration
flag.

With ClearKey instead of a DRM system, `cbcs` gives us sample-level encryption without
vendor fees — but ClearKey is not reliably usable through hls.js today, and Shaka Player
would become the required client. Worth revisiting when hls.js's ClearKey support lands.

**Important:** packaging as `cbcs` is exactly the step that makes a later DRM migration a
key-management change rather than a re-encode. That is why the roadmap reaches `cbcs`
before it reaches any DRM vendor.

### Full DRM — explicitly out of scope for v1

Requires licence-server integration, per-vendor certificates, and for Widevine L1 a
commercial relationship. Adding it to the core would make the project non-self-hostable
and contradict its purpose. It belongs behind a `DrmProvider` port as an optional
integration. See [ADR-0004](adr/0004-encryption-aes128-not-drm.md).

## 3. Key management

```
                  master key  (env var in v1; KMS/Vault later)
                       │  AES-256-GCM envelope encryption
                       ▼
PostgreSQL  content_keys( kid, key_ciphertext, nonce, tag, provider, rotation_index )
                       │  unwrapped in memory, per request, never persisted
                       ▼
Edge key endpoint  ──▶  16 raw bytes  ──▶  player     (Cache-Control: no-store)
```

`KeyProvider` interface:

```ts
interface KeyProvider {
  generateContentKey(assetId: string): Promise<{ kid: Buffer; key: Buffer }>;
  wrap(key: Buffer, context: KeyContext): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context: KeyContext): Promise<Buffer>;
  rotateMasterKey?(): Promise<void>;
}
```

v1 implementation: `EnvelopeKeyProvider` with the master key from
`OBSCURA_MASTER_KEY` (32 bytes, base64). Planned: `AwsKmsKeyProvider`,
`VaultKeyProvider`, `GcpKmsKeyProvider`. The `KeyContext` (asset id, kid) is bound as AEAD
additional authenticated data, so a wrapped key cannot be transplanted between assets.

**Rules:**

- Content keys are generated with a CSPRNG, one per asset by default.
- Keys are **never** written to object storage, never included in a manifest, never
  logged, never returned by any API other than the key endpoint, and never held in a
  long-lived variable.
- The key file FFmpeg needs during packaging (`-hls_key_info_file`) is written to a
  worker-local temporary directory with mode 0600 and unlinked in a `finally` block. It
  must never land on a shared volume.
- Master key rotation re-wraps all content keys in a single transaction; content keys
  themselves need not change.
- Key rotation *within* an asset (`#EXT-X-KEY` every N segments) is supported and is a
  security tunable: it sets how quickly a revoked session loses access to new content.

## 4. Where the encryption actually happens

**FFmpeg does not do it.** Its HLS muxer cannot encrypt fMP4/CMAF segments — the
combination fails with `Not yet implemented in FFmpeg, patches welcome`; encryption is
supported for MPEG-TS only.

Obscura therefore packages unencrypted and applies AES-128-CBC with PKCS#7 padding itself,
then inserts the `#EXT-X-KEY` tag. That is precisely what `METHOD=AES-128` means in the
specification, so nothing here is a custom scheme. Full reasoning and the alternatives in
[ADR-0013](adr/0013-encrypt-after-packaging.md).

Two consequences worth knowing:

- **Key material never touches disk.** FFmpeg's `-hls_key_info_file` route requires writing
  the raw key to a file for it to read. Encrypting in-process removes that exposure.
- **The initialisation section is encrypted too**, and `#EXT-X-KEY` is written before
  `#EXT-X-MAP` so it applies. The spec requires this when AES-128 applies, and hls.js
  expects it — it decrypts the init segment for full-segment AES-CBC.

## 5. What is stored

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="{{KEY_URI}}",IV=0x9c1f…
#EXTINF:4.000,
seg_00001.m4s
```

The canonical playlist stored in object storage carries a **placeholder** key URI and
relative segment URIs. The edge substitutes the session-scoped key endpoint and rewrites
segment URIs per the active delivery strategy when it generates the session manifest. The
stored artifact is therefore identical for every viewer — which is what keeps it
hashable, cacheable, and free of per-user data.

The IV is explicit per segment rather than derived from the media sequence number, so
that segment hashes are stable and a segment's decryptability does not depend on its
position in a playlist we rewrite.

## 6. Encrypting subtitles

WebVTT segments are delivered through the same authorization path and can be encrypted
with the same mechanism. **This is an open verification item** — encrypted VTT support
differs between hls.js and Safari. If it proves unreliable, subtitles will be delivered
unencrypted but still token-authorized, and that reduction will be documented rather than
glossed over.

## 7. Cryptographic erasure

Deleting objects is best-effort against infrastructure you do not fully control. Replicas,
point-in-time snapshots, an edge that ignores an invalidation, a backup taken an hour
before the request — none are reachable by a `DELETE` call.

They are also AES-128 ciphertext. Destroy the wrapped key row and every one of those copies
is inert forever. This turns "we deleted everything we could find" into "everything that
remains is cryptographically unreadable" — a materially stronger claim, and one the signed
deletion record can honestly assert.

Design consequences that follow from treating key destruction as a deletion control:

- **One content key per asset, not one per rendition**, by default. Destroying an asset
  must be a single unambiguous act; scattering keys across renditions creates a way to
  half-delete something.
- **Key rotation within an asset is deferred**, for the same reason. Rotation is a useful
  access control but it multiplies the keys that must all be destroyed together.
- **Deletion destroys the row, it does not mark it revoked.** A `revoked_at` timestamp
  leaves the key material sitting in the database.

Two operator obligations can silently undo this, and both are documented in
[privacy.md §5](privacy.md#5-cryptographic-erasure): database backups containing
`content_keys` must not outlive the deletion SLA, and master-key custody must be protected
accordingly.

## 8. Roadmap

| Phase | Capability |
|---|---|
| v1 | AES-128 over CMAF; DB-backed envelope key provider; session-scoped key endpoint; key destruction on delete |
| v1.x | KMS/Vault key providers (KMS scheduled-deletion gives the same erasure property at master level, with an audit trail); key-usage audit events |
| v2 | `cbcs` CMAF packaging + EME ClearKey (with Shaka Player as the reference client for that path) |
| v3 | `DrmProvider` port; Widevine / FairPlay / PlayReady as optional integrations, core remains fully functional without them |
