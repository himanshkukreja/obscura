import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { IntegrityManifest, RenditionIntegrity, DeletionRecord } from '@obscura/shared';
import { buildMerkleTree, leafHashFromDigest } from './merkle.ts';
import { signDocument, verifyDocument, type Signature } from './sign.ts';

/**
 * The asset root binds every rendition root, the playlist hashes, the source hash and the
 * pipeline identity into one value. Signing it means tampering anywhere in the tree
 * invalidates the signature.
 */
export function computeAssetRoot(m: Omit<IntegrityManifest, 'assetRoot' | 'signature'>): string {
  const parts: string[] = [
    `source:${m.source.sha256}`,
    `probe:${m.source.probeSha256}`,
    `pipeline:${m.pipeline.version}:${m.pipeline.ladderConfigSha256}`,
  ];
  for (const r of [...m.renditions].sort((a, b) => a.name.localeCompare(b.name))) {
    parts.push(`rendition:${r.name}:${r.merkleRoot}:${r.playlistSha256}:${r.initSha256 ?? '-'}`);
  }
  for (const s of [...m.subtitles].sort((a, b) => a.language.localeCompare(b.language))) {
    parts.push(`subtitle:${s.language}:${s.merkleRoot}:${s.playlistSha256}`);
  }
  const leaves = parts.map((p) => leafHashFromDigest(createHash('sha256').update(p).digest('hex')));
  return buildMerkleTree(leaves).root.toString('hex');
}

export function buildRenditionIntegrity(args: {
  name: string;
  width: number;
  height: number;
  method: 'AES-128' | 'NONE';
  kid: string | null;
  playlistSha256: string;
  initSha256: string | null;
  segments: { index: number; sha256: string; size: number }[];
}): RenditionIntegrity {
  const ordered = [...args.segments].sort((a, b) => a.index - b.index);
  return {
    name: args.name,
    width: args.width,
    height: args.height,
    encryption: { method: args.method, kid: args.kid },
    playlistSha256: args.playlistSha256,
    initSha256: args.initSha256,
    segmentCount: ordered.length,
    merkleRoot: buildMerkleTree(ordered.map((s) => leafHashFromDigest(s.sha256))).root.toString('hex'),
    segments: ordered,
  };
}

export function finalizeManifest(
  draft: Omit<IntegrityManifest, 'assetRoot' | 'signature'>,
  privateKey: KeyObject,
  keyId: string,
): IntegrityManifest {
  const withRoot: IntegrityManifest = { ...draft, assetRoot: computeAssetRoot(draft) };
  return signDocument(withRoot, privateKey, keyId);
}

export function signDeletionRecord(
  record: Omit<DeletionRecord, 'signature'>, privateKey: KeyObject, keyId: string,
): DeletionRecord {
  return signDocument(record as DeletionRecord, privateKey, keyId);
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'no_signature' | 'bad_signature' | 'root_mismatch'; detail?: string };

/**
 * Verify a manifest end to end: the signature covers the asset root, and the asset root
 * must actually be derivable from the rendition contents it claims.
 */
export function verifyManifest(m: IntegrityManifest, publicKey: KeyObject): VerifyOutcome {
  if (!m.signature) return { ok: false, reason: 'no_signature' };
  if (!verifyDocument(m, publicKey)) return { ok: false, reason: 'bad_signature' };
  const { assetRoot: _r, signature: _s, ...draft } = m;
  const recomputed = computeAssetRoot(draft);
  if (recomputed !== m.assetRoot) {
    return { ok: false, reason: 'root_mismatch', detail: `expected ${m.assetRoot}, computed ${recomputed}` };
  }
  return { ok: true };
}

export function verifyDeletionRecord(r: DeletionRecord, publicKey: KeyObject): boolean {
  return verifyDocument(r, publicKey);
}

export type { Signature };
