import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree, buildProof, verifyProof, merkleRootHex, leafHashFromDigest, verifySegmentBytes } from './merkle.ts';

const digests = (n: number) =>
  Array.from({ length: n }, (_, i) => createHash('sha256').update(`seg-${i}`).digest('hex'));

describe('merkle tree', () => {
  it('produces a stable root across runs', () => {
    expect(merkleRootHex(digests(7))).toBe(merkleRootHex(digests(7)));
  });

  it('changes the root when any leaf changes', () => {
    const a = digests(8);
    const b = [...a];
    b[3] = createHash('sha256').update('tampered').digest('hex');
    expect(merkleRootHex(a)).not.toBe(merkleRootHex(b));
  });

  it('verifies a proof for every leaf, at odd and even sizes', () => {
    for (const n of [1, 2, 3, 5, 8, 13, 100]) {
      const d = digests(n);
      const tree = buildMerkleTree(d.map(leafHashFromDigest));
      for (let i = 0; i < n; i++) {
        expect(verifyProof(buildProof(tree, i), n), `n=${n} i=${i}`).toBe(true);
      }
    }
  });

  it('rejects a proof presented against the wrong leaf count', () => {
    const d = digests(8);
    const tree = buildMerkleTree(d.map(leafHashFromDigest));
    expect(verifyProof(buildProof(tree, 2), 9)).toBe(false);
  });

  it('rejects a proof with a tampered path', () => {
    const d = digests(8);
    const tree = buildMerkleTree(d.map(leafHashFromDigest));
    const p = buildProof(tree, 2);
    p.path[0]!.hash = createHash('sha256').update('nope').digest('hex');
    expect(verifyProof(p, 8)).toBe(false);
  });

  it('promotes odd nodes rather than duplicating them (CVE-2012-2459)', () => {
    // If the last node were duplicated, [a,b,c] and [a,b,c,c] would share a root.
    const three = digests(3);
    const four = [...three, three[2]!];
    expect(merkleRootHex(three)).not.toBe(merkleRootHex(four));
  });

  it('domain-separates leaves from internal nodes', () => {
    // A single-leaf tree root must not equal the bare leaf digest.
    const d = digests(1);
    expect(merkleRootHex(d)).not.toBe(d[0]);
  });

  it('verifies real segment bytes against a proof', () => {
    const blobs = [Buffer.from('aaa'), Buffer.from('bbb'), Buffer.from('ccc')];
    const d = blobs.map((b) => createHash('sha256').update(b).digest('hex'));
    const tree = buildMerkleTree(d.map(leafHashFromDigest));
    expect(verifySegmentBytes(blobs[1]!, buildProof(tree, 1), 3)).toBe(true);
    expect(verifySegmentBytes(Buffer.from('xxx'), buildProof(tree, 1), 3)).toBe(false);
  });
});
