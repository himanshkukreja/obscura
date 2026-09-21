#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '@obscura/shared';
import { createDb, AssetRepository, DeletionRepository } from '@obscura/db';
import { S3StorageProvider, StorageKeys, listAll } from '@obscura/storage';
import {
  sha256File, verifyManifest, verifyDeletionRecord, publicKeyFromSeed,
  buildMerkleTree, leafHashFromDigest, buildProof, verifySegmentBytes,
} from '@obscura/integrity';
import { probe as ffprobe, selectLadder } from '@obscura/media';
import type { IntegrityManifest } from '@obscura/shared';

const HELP = `obscura - private video delivery from your own storage

Usage:
  obscura upload <file> [--api <url>] [--key <api-key>] [--ref <external-ref>] [--title <t>]
  obscura process <asset-id> [--api <url>] [--key <api-key>]
  obscura inspect <asset-id> [--api <url>] [--key <api-key>]
  obscura status  <asset-id> [--api <url>] [--key <api-key>]
  obscura verify  <asset-id> [--quick]
  obscura verify-file <segment-file> --proof <proof.json>
  obscura delete  <asset-id> [--reason <r>] [--api <url>] [--key <api-key>]
  obscura probe   <file>
  obscura hash    <file>

Environment:
  OBSCURA_API   default API base url   (default http://localhost:3001)
  OBSCURA_KEY   API key
  DATABASE_URL, S3_* for the local verify commands
`;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const api = () => (flag('api') ?? process.env['OBSCURA_API'] ?? 'http://localhost:3001').replace(/\/+$/, '');
const apiKey = () => flag('key') ?? process.env['OBSCURA_KEY'] ?? '';

function die(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${api()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body as { error?: { code?: string; message?: string } };
    die(`${res.status} ${e?.error?.code ?? ''}: ${e?.error?.message ?? text}`);
  }
  return body;
}

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

switch (cmd) {
  case 'upload': {
    const file = args[1];
    if (!file) die(HELP);
    const info = await stat(file);
    const created = await call('/api/v1/assets', {
      method: 'POST',
      body: JSON.stringify({
        original_filename: basename(file),
        size: info.size,
        content_type: guessType(file),
        external_ref: flag('ref'),
        title: flag('title'),
      }),
    }) as { asset_id: string; upload: { url: string; headers: Record<string, string> } };

    process.stderr.write(`uploading ${info.size} bytes...\n`);
    const put = await fetch(created.upload.url, {
      method: 'PUT',
      // Node needs `duplex` to stream a request body; it is not in the DOM RequestInit type.
      duplex: 'half',
      body: createReadStream(file),
      headers: { ...created.upload.headers, 'Content-Length': String(info.size) },
    } as RequestInit);
    if (!put.ok) die(`upload failed: ${put.status} ${await put.text()}`);

    const committed = await call(`/api/v1/assets/${created.asset_id}/commit`, { method: 'POST' });
    out({ asset_id: created.asset_id, ...(committed as object) });
    break;
  }

  case 'process':
    out(await call(`/api/v1/assets/${req(args[1])}/process`, { method: 'POST' }));
    break;

  case 'inspect':
    out(await call(`/api/v1/assets/${req(args[1])}`));
    break;

  case 'status':
    out(await call(`/api/v1/assets/${req(args[1])}/status`));
    break;

  case 'delete': {
    const id = req(args[1]);
    out(await call(`/api/v1/assets/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: flag('reason') ?? 'operator', requested_by: 'cli' }),
    }));
    process.stderr.write('deletion queued; fetch the record with:\n');
    process.stderr.write(`  curl -H "Authorization: Bearer $OBSCURA_KEY" ${api()}/api/v1/assets/${id}/deletion-record\n`);
    break;
  }

  case 'probe': {
    const cfg = loadConfig();
    out(await ffprobe(cfg.media.ffprobePath, req(args[1])));
    break;
  }

  case 'hash': {
    const { hex, size } = await sha256File(req(args[1]));
    out({ sha256: hex, size });
    break;
  }

  case 'ladder': {
    const cfg = loadConfig();
    const p = await ffprobe(cfg.media.ffprobePath, req(args[1]));
    out({ source: `${p.displayWidth}x${p.displayHeight}`, ladder: selectLadder(p, cfg.ladder) });
    break;
  }

  case 'verify': await verify(req(args[1]), has('quick')); break;

  case 'verify-file': await verifyFile(req(args[1]), req(flag('proof'))); break;

  default:
    process.stdout.write(HELP);
    process.exit(cmd ? 1 : 0);
}

function req(v: string | undefined): string {
  if (!v) die(HELP);
  return v;
}

function guessType(f: string): string {
  const e = f.toLowerCase().split('.').pop();
  return ({ mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
    webm: 'video/webm', avi: 'video/x-msvideo', m4v: 'video/x-m4v' } as Record<string, string>)[e ?? '']
    ?? 'application/octet-stream';
}

/**
 * Verify against storage directly, not through the API - the point is to check what is
 * actually there, independently.
 */
async function verify(assetId: string, quick: boolean): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg.database.url, 2);
  const storage = new S3StorageProvider(cfg.storage);
  const pub = publicKeyFromSeed(cfg.keys.integritySeed);

  try {
    const assets = new AssetRepository(db);
    const asset = await assets.byId(assetId);

    if (!asset || asset.status === 'DELETED') {
      const rec = await new DeletionRepository(db).byAssetId(assetId);
      if (rec) {
        const sigOk = verifyDeletionRecord(rec, pub);
        out({
          result: 'DELETED',
          signature: sigOk ? 'valid' : 'INVALID',
          objects_deleted: rec.objectsDeleted,
          storage_verified_empty: rec.storageVerifiedEmpty,
          content_keys_destroyed: rec.contentKeysDestroyed,
          completed_at: rec.completedAt,
          note: 'Content keys were destroyed; any surviving copy is unreadable ciphertext.',
        });
        process.exit(sigOk && rec.storageVerifiedEmpty ? 0 : 1);
      }
      die(`asset ${assetId} not found`);
    }
    if (!asset.integrity_key) die(`asset ${assetId} has no integrity manifest (status ${asset.status})`);

    const got = await storage.get(asset.delivery_bucket!, asset.integrity_key);
    const chunks: Buffer[] = [];
    for await (const c of got.body) chunks.push(c as Buffer);
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as IntegrityManifest;

    const v = verifyManifest(manifest, pub);
    if (!v.ok) {
      out({ result: 'FAIL', stage: 'manifest', reason: v.reason, detail: v.detail });
      process.exit(1);
    }

    const problems: { key: string; expected: string; actual: string }[] = [];
    let checked = 0;

    for (const r of manifest.renditions) {
      const plKey = StorageKeys.playlist(assetId, r.name);
      const actual = await hashObject(storage, asset.delivery_bucket!, plKey);
      checked++;
      if (actual !== r.playlistSha256) {
        problems.push({ key: plKey, expected: r.playlistSha256, actual });
      }
      if (quick) continue;

      for (const s of r.segments) {
        const key = StorageKeys.segment(assetId, r.name, s.index + 1,
          manifest.pipeline.packaging.container === 'fmp4' ? 'm4s' : 'ts');
        const a = await hashObject(storage, asset.delivery_bucket!, key);
        checked++;
        if (a !== s.sha256) problems.push({ key, expected: s.sha256, actual: a });
      }
    }

    if (!quick) {
      const stray = (await listAll(storage, asset.delivery_bucket!, StorageKeys.hlsPrefix(assetId)))
        .filter((o) => /seg_\d{5}\.(m4s|ts)$/.test(o.key))
        .length;
      const claimed = manifest.renditions.reduce((n, r) => n + r.segmentCount, 0);
      if (stray !== claimed) {
        problems.push({ key: '(segment count)', expected: String(claimed), actual: String(stray) });
      }
    }

    out({
      result: problems.length === 0 ? 'OK' : 'FAIL',
      asset_id: assetId,
      asset_root: manifest.assetRoot,
      signature: 'valid',
      signing_key: manifest.signature?.keyId,
      source_sha256: manifest.source.sha256,
      objects_checked: checked,
      mode: quick ? 'quick (signature + playlists)' : 'full',
      problems,
      note: problems.length
        ? 'These bytes are NOT the ones the pipeline produced.'
        : 'These bytes are byte-identical to what the pipeline produced. This says nothing about whether a visually similar copy elsewhere is a re-encode of this video.',
    });
    process.exit(problems.length === 0 ? 0 : 1);
  } finally {
    await db.close();
  }
}

async function hashObject(storage: S3StorageProvider, bucket: string, key: string): Promise<string> {
  try {
    const got = await storage.get(bucket, key);
    const chunks: Buffer[] = [];
    for await (const c of got.body) chunks.push(c as Buffer);
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
  } catch {
    return '(missing)';
  }
}

/** Is this file ours? Answerable by anyone holding the proof and the public key. */
async function verifyFile(file: string, proofPath: string): Promise<void> {
  const bytes = await readFile(file);
  const p = JSON.parse(await readFile(proofPath, 'utf8')) as {
    proof: Parameters<typeof verifySegmentBytes>[1]; segment_count: number;
  };
  const ok = verifySegmentBytes(bytes, p.proof, p.segment_count);
  out({
    result: ok ? 'MEMBER' : 'NOT A MEMBER',
    file,
    note: ok
      ? 'This file is byte-identical to a segment of the signed asset.'
      : 'These bytes are not a segment of that asset. This does NOT mean the content is unrelated - a re-encode of the same video would also fail, and no hash can tell you otherwise.',
  });
  process.exit(ok ? 0 : 1);
}

export { buildMerkleTree, leafHashFromDigest, buildProof };
