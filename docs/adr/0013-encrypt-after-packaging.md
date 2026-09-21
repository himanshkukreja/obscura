# ADR-0013 — Apply AES-128 after packaging, not via FFmpeg

**Status:** Accepted · 2026-09-21
**Amends:** [ADR-0004](0004-encryption-aes128-not-drm.md) (implementation, not decision)

## Context
ADR-0004 chose `METHOD=AES-128` over CMAF and assumed the obvious implementation: FFmpeg's
`-hls_key_info_file`, which writes the key to a file, encrypts during packaging, and emits
the `#EXT-X-KEY` tag itself.

That assumption is wrong, and it was caught the first time the encryption test ran against
real media:

```
$ ffmpeg ... -hls_segment_type fmp4 -hls_key_info_file enc.keyinfo out.m3u8
[vf#0:0] Terminating thread with return code -1163346256
         (Not yet implemented in FFmpeg, patches welcome)
Conversion failed!
```

Isolating the combination confirms it:

| container | encryption | result |
|---|---|---|
| fmp4 | none | works |
| mpegts | AES-128 | works |
| **fmp4** | **AES-128** | **unimplemented** |

FFmpeg's HLS muxer supports encryption for MPEG-TS only. Keeping FFmpeg-side encryption
would have meant abandoning CMAF, and with it the single-encode/dual-manifest property and
the migration path to CENC — the whole basis of ADR-0003.

## Decision
FFmpeg packages **unencrypted**. Obscura then encrypts each segment and the
initialisation section itself, using AES-128-CBC with PKCS#7 padding, and inserts the
`#EXT-X-KEY` tag into the stored playlist.

This is the construction the specification defines. Nothing is invented: `METHOD=AES-128`
*is* AES-128-CBC over the whole segment with PKCS#7 padding.

The `#EXT-X-KEY` tag is placed before `#EXT-X-MAP`, so it applies to the initialisation
section too. That is what the spec requires when AES-128 applies, and what hls.js expects —
it decrypts the init segment whenever the method is full-segment AES-CBC.

## Alternatives considered

**Switch to MPEG-TS so FFmpeg can encrypt.** The only option that keeps encryption inside
FFmpeg. Rejected: it forfeits ADR-0003 entirely — no CMAF, no shared segments with a future
DASH manifest, no path to CENC — in exchange for avoiding about sixty lines of
well-specified code.

**Add Shaka Packager or Bento4 as a packaging backend.** Both handle CMAF encryption
properly. Rejected for v1: Shaka Packager is documented as weak at plain full-segment
AES-128 (issues #714, #776, #1587), and Bento4 is GPLv2/commercial dual-licensed, which is
a poor fit for an Apache-2.0 project. Either remains available later behind a `Packager`
port.

**Ship unencrypted and rely on tokens alone.** Rejected: it would give up cryptographic
erasure ([ADR-0011](0011-verified-deletion.md)), which turned out to be the strongest
deletion guarantee the system has.

## Consequences
- **CMAF is preserved**, so ADR-0003 and the CENC path stand.
- **Key material never touches disk.** The `-hls_key_info_file` route requires writing the
  raw key to a file for FFmpeg to read; encrypting in-process removes that exposure
  entirely. This is a security improvement, not just a workaround.
- **One code path for both containers**, and an explicit per-asset IV rather than one
  derived from the media sequence number — so a segment's decryptability does not depend
  on its position in a playlist we rewrite.
- Segments are buffered in memory to encrypt. Acceptable at a 4-second segment size
  (single-digit MB); a streaming cipher is the fix if very large segments are ever
  configured.
- **Stored hashes are of the encrypted bytes**, which is what an auditor can fetch from a
  CDN without holding any key.
- The relevant FFmpeg behaviour is version-dependent. If a future release implements fMP4
  encryption, this decision is worth revisiting — but the no-key-on-disk property would
  still argue for keeping it.
