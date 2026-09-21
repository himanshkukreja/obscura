import { createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * HLS `METHOD=AES-128`: AES-128-CBC over the whole segment with PKCS#7 padding, exactly
 * as specified by RFC 8216 / draft-pantos-hls-rfc8216bis. Nothing here is invented.
 *
 * WHY WE DO THIS OURSELVES instead of ffmpeg's `-hls_key_info_file`:
 *
 *   FFmpeg's HLS muxer cannot encrypt fMP4/CMAF segments. Asking it to fails outright
 *   with "Not yet implemented in FFmpeg, patches welcome". It supports encryption only
 *   for MPEG-TS. Choosing ffmpeg-side encryption would mean giving up CMAF - and with it
 *   the single-encode/dual-manifest property and the path to CENC (see ADR-0003).
 *
 * Encrypting after packaging is also better on its own merits:
 *
 *   - Key material never touches disk. The `-hls_key_info_file` route requires writing the
 *     raw key to a file for ffmpeg to read.
 *   - One code path for both containers.
 *   - Explicit per-asset IV, so a segment's decryptability does not depend on its position
 *     in a playlist we rewrite.
 *
 * The Media Initialization Section (EXT-X-MAP) is encrypted too. That is what the spec
 * requires when AES-128 applies, and what hls.js expects - it decrypts the init segment
 * whenever the method is full-segment AES-CBC.
 */
export function encryptSegment(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  assertParams(key, iv);
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(true); // PKCS#7, per the specification
  return Buffer.concat([c.update(plaintext), c.final()]);
}

export function decryptSegment(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  assertParams(key, iv);
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

function assertParams(key: Buffer, iv: Buffer): void {
  if (key.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`);
  if (iv.length !== 16) throw new Error(`AES-128 IV must be 16 bytes, got ${iv.length}`);
}

/**
 * Build the `#EXT-X-KEY` line.
 *
 * The IV is explicit rather than derived from the media sequence number, so segment hashes
 * stay stable and decryptability does not depend on playlist position.
 */
export function keyTag(uri: string, iv: Buffer): string {
  return `#EXT-X-KEY:METHOD=AES-128,URI="${uri}",IV=0x${iv.toString('hex')}`;
}
