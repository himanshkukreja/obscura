import type { FastifyInstance } from 'fastify';
import { notFound, type IntegrityManifest } from '@obscura/shared';
import {
  buildMerkleTree, buildProof, leafHashFromDigest, publicKeyJwks, verifyManifest,
} from '@obscura/integrity';
import { requireClient } from '../app.ts';
import type { Deps } from '../deps.ts';

export function registerIntegrityRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/assets/:id/integrity', async (req) => {
    await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const m = await loadManifest(deps, id);
    return m;
  });

  /**
   * Merkle inclusion proof: verify one segment without our cooperation and without the
   * full hash set. ~400 bytes instead of ~500 KB for a two-hour asset.
   */
  app.get('/api/v1/assets/:id/integrity/proof', async (req) => {
    await requireClient(deps, req);
    const { id } = req.params as { id: string };
    const q = req.query as { rendition?: string; segment?: string };
    if (!q.rendition || q.segment === undefined) {
      throw notFound('rendition and segment query parameters are required');
    }
    const m = await loadManifest(deps, id);
    const r = m.renditions.find((x) => x.name === q.rendition);
    if (!r) throw notFound(`Rendition ${q.rendition} not found`);

    const index = Number(q.segment);
    if (!Number.isInteger(index) || index < 0 || index >= r.segmentCount) {
      throw notFound(`Segment ${q.segment} out of range (0..${r.segmentCount - 1})`);
    }

    const tree = buildMerkleTree(r.segments.map((s) => leafHashFromDigest(s.sha256)));
    return {
      asset_id: id,
      rendition: r.name,
      segment_count: r.segmentCount,
      segment_sha256: r.segments[index]!.sha256,
      proof: buildProof(tree, index),
      merkle_root: r.merkleRoot,
      asset_root: m.assetRoot,
      signature: m.signature,
    };
  });

  // Public and unauthenticated on purpose: a provenance claim nobody else can check is
  // self-referential.
  app.get('/.well-known/obscura-integrity-keys.json', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return publicKeyJwks([
      { keyId: deps.cfg.keys.integrityKeyId, publicKey: deps.integrityPublic },
    ]);
  });
}

async function loadManifest(deps: Deps, assetId: string): Promise<IntegrityManifest> {
  const asset = await deps.repos.assets.byId(assetId);
  if (!asset?.integrity_key) throw notFound(`No integrity manifest for ${assetId}`);
  const got = await deps.storage.get(asset.delivery_bucket!, asset.integrity_key);
  const chunks: Buffer[] = [];
  for await (const c of got.body) chunks.push(c as Buffer);
  const m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as IntegrityManifest;

  const v = verifyManifest(m, deps.integrityPublic);
  if (!v.ok) {
    // Serving a manifest we cannot verify would undermine the whole point.
    throw notFound(`Integrity manifest for ${assetId} failed verification: ${v.reason}`);
  }
  return m;
}
