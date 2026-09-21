import { createHash } from 'node:crypto';
import type { MerkleProof } from '@obscura/shared';

/**
 * Merkle tree over segment hashes.
 *
 * Two details that are easy to get wrong and expensive to fix later:
 *
 *  - Domain separation. Leaves are H(0x00 || data), internal nodes H(0x01 || l || r).
 *    Without it an internal node can be presented as a leaf (second-preimage). RFC 6962
 *    does the same thing for the same reason.
 *  - Odd nodes are PROMOTED, not duplicated. Duplicating the last node is the flaw behind
 *    Bitcoin's CVE-2012-2459, where two distinct trees produce the same root.
 */
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

export const leafHash = (data: Buffer): Buffer =>
  createHash('sha256').update(LEAF).update(data).digest();

export const leafHashFromDigest = (digestHex: string): Buffer =>
  createHash('sha256').update(LEAF).update(Buffer.from(digestHex, 'hex')).digest();

export const nodeHash = (l: Buffer, r: Buffer): Buffer =>
  createHash('sha256').update(NODE).update(l).update(r).digest();

export interface MerkleTree {
  root: Buffer;
  levels: Buffer[][];
  leafCount: number;
}

export function buildMerkleTree(leaves: Buffer[]): MerkleTree {
  if (leaves.length === 0) {
    // An empty tree still needs a stable, distinguishable root.
    return {
      root: createHash('sha256').update(NODE).update(Buffer.from('empty')).digest(),
      levels: [[]],
      leafCount: 0,
    };
  }
  const levels: Buffer[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i]!;
      const r = cur[i + 1];
      // Promote, never duplicate: duplicating the last node is CVE-2012-2459.
      next.push(r ? nodeHash(l, r) : Buffer.from(l));
    }
    levels.push(next);
    cur = next;
  }

  // Bind the leaf count into the root so a tree cannot be reinterpreted at another size.
  const root = createHash('sha256')
    .update(NODE)
    .update(cur[0]!)
    .update(Buffer.from(String(leaves.length), 'utf8'))
    .digest();

  return { root, levels, leafCount: leaves.length };
}

export function merkleRootHex(segmentDigestsHex: string[]): string {
  return buildMerkleTree(segmentDigestsHex.map(leafHashFromDigest)).root.toString('hex');
}

export function buildProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  if (leafIndex < 0 || leafIndex >= tree.leafCount) {
    throw new Error(`Leaf index ${leafIndex} out of range (0..${tree.leafCount - 1})`);
  }
  const path: MerkleProof['path'] = [];
  let idx = leafIndex;
  for (let lvl = 0; lvl < tree.levels.length - 1; lvl++) {
    const level = tree.levels[lvl]!;
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = level[siblingIdx];
    if (sibling) path.push({ hash: sibling.toString('hex'), side: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return {
    leafIndex,
    leafHash: tree.levels[0]![leafIndex]!.toString('hex'),
    path,
    root: tree.root.toString('hex'),
  };
}

export function verifyProof(proof: MerkleProof, leafCount: number): boolean {
  let acc: Buffer = Buffer.from(proof.leafHash, 'hex');
  for (const step of proof.path) {
    const sib = Buffer.from(step.hash, 'hex');
    acc = step.side === 'left' ? nodeHash(sib, acc) : nodeHash(acc, sib);
  }
  const root = createHash('sha256')
    .update(NODE).update(acc).update(Buffer.from(String(leafCount), 'utf8')).digest();
  return root.toString('hex') === proof.root;
}

/** Verify a raw segment against a proof: hashes the bytes, then walks the path. */
export function verifySegmentBytes(bytes: Buffer, proof: MerkleProof, leafCount: number): boolean {
  const expected = leafHashFromDigest(createHash('sha256').update(bytes).digest('hex'));
  if (expected.toString('hex') !== proof.leafHash) return false;
  return verifyProof(proof, leafCount);
}
