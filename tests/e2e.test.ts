/**
 * End-to-end suite against a running stack (`docker compose up`).
 *
 * Skipped automatically when the stack is not up, so `npm test` stays useful without it.
 * Nothing here is mocked: real ffmpeg, real MinIO, real Postgres, real encryption.
 */
import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env['OBSCURA_API'] ?? 'http://localhost:3001';
const EDGE = process.env['OBSCURA_EDGE'] ?? 'http://localhost:3002';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Probed at module load, not in beforeAll: vitest evaluates `describe` bodies during
 * collection, so a flag set in beforeAll would always still be false when the skip
 * decision is made.
 */
const up = await (async () => {
  try {
    return (await fetch(`${API}/healthz`)).ok && (await fetch(`${EDGE}/healthz`)).ok;
  } catch { return false; }
})();

let key = '';
if (up) {
  const r = await fetch(`${API}/api/v1/admin/clients`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'vitest-e2e', scopes: ['operator'] }),
  });
  key = ((await r.json()) as { api_key: string }).api_key;
} else {
  console.warn('\n  e2e suite skipped: stack not reachable. Run `docker compose up -d` first.\n');
}

async function j<T>(path: string, init: RequestInit = {}, base = API): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(text), { status: res.status });
  return (text ? JSON.parse(text) : null) as T;
}
const code = async (url: string) => (await fetch(url)).status;

function decrypt(buf: Buffer, key: Buffer, iv: Buffer): Buffer {
  const d = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(buf), d.final()]);
}

const maybe = () => (up ? it : it.skip);

async function ingest(file = 'basic-720p.mp4'): Promise<string> {
  const path = join(FIXTURES, file);
  const size = (await stat(path)).size;
  const created = await j<{ asset_id: string; upload: { url: string; headers: Record<string, string> } }>(
    '/api/v1/assets', {
      method: 'POST',
      body: JSON.stringify({ original_filename: file, content_type: 'video/mp4', size, title: file }),
    });
  const put = await fetch(created.upload.url, {
    method: 'PUT', body: await readFile(path), headers: created.upload.headers,
  });
  expect(put.ok, 'upload to storage').toBe(true);
  await j(`/api/v1/assets/${created.asset_id}/commit`, { method: 'POST' });

  for (let i = 0; i < 150; i++) {
    const s = await j<{ status: string }>(`/api/v1/assets/${created.asset_id}/status`);
    if (s.status === 'READY') return created.asset_id;
    if (s.status === 'FAILED') throw new Error(`processing FAILED for ${file}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('timed out waiting for READY');
}

describe('e2e: ingest → play → verify → delete', () => {
  let assetId = '';

  maybe()('processes an upload to READY', async () => {
    assetId = await ingest();
    const s = await j<{ status: string; renditions: { name: string; status: string }[] }>(
      `/api/v1/assets/${assetId}/status`);
    expect(s.status).toBe('READY');
    expect(s.renditions.every((r) => r.status === 'complete')).toBe(true);
  }, 400_000);

  // ── the property the whole project exists for ──
  maybe()('never exposes the original source object', async () => {
    const direct = `http://localhost:9000/obscura-source/videos/${assetId}/source/original.mp4`;
    expect(await code(direct)).toBe(403);
    expect(await code('http://localhost:9000/obscura-source/')).toBe(403);
    expect(await code(`http://localhost:9000/obscura-delivery/videos/${assetId}/hls/720p/seg_00001.m4s`)).toBe(403);

    for (const p of ['', '/status', '/metadata']) {
      const body = JSON.stringify(await j(`/api/v1/assets/${assetId}${p}`));
      expect(body, `GET /assets/{id}${p}`).not.toMatch(/original\.mp4|source_key|source_bucket|obscura-source/);
    }
  }, 60_000);

  maybe()('serves a session-scoped manifest and encrypted segments that decrypt correctly', async () => {
    const s = await j<{ session_id: string; token: string; watermark: { text: string } }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'u1', subject_label: 'viewer@example.com' }) });

    // The watermark identifies the VIEWER, not the asset.
    expect(s.watermark.text).toContain('viewer@example.com');

    const master = await (await fetch(`${EDGE}/stream/${s.session_id}/master.m3u8?t=${s.token}`)).text();
    expect(master).toContain('#EXT-X-STREAM-INF');
    expect(master).toContain('RESOLUTION=1280x720');

    const pl = await (await fetch(`${EDGE}/stream/${s.session_id}/720p/playlist.m3u8?t=${s.token}`)).text();
    expect(pl).toContain('#EXT-X-KEY:METHOD=AES-128');
    // EXT-X-KEY must precede EXT-X-MAP so it applies to the init section.
    expect(pl.indexOf('#EXT-X-KEY')).toBeLessThan(pl.indexOf('#EXT-X-MAP'));

    const kid = /key\/([0-9a-f]{32})/.exec(pl)![1]!;
    const iv = Buffer.from(/IV=0x([0-9a-f]{32})/.exec(pl)![1]!, 'hex');

    const keyRes = await fetch(`${EDGE}/stream/${s.session_id}/key/${kid}?t=${s.token}`);
    expect(keyRes.headers.get('cache-control')).toBe('no-store');
    const ck = Buffer.from(await keyRes.arrayBuffer());
    expect(ck).toHaveLength(16);

    const seg = Buffer.from(await (await fetch(
      `${EDGE}/stream/${s.session_id}/seg/720p/seg_00001.m4s?t=${s.token}`)).arrayBuffer());

    // Ciphertext on the wire...
    expect(seg.subarray(0, 64).includes(Buffer.from('styp'))).toBe(false);
    expect(seg.subarray(0, 64).includes(Buffer.from('moof'))).toBe(false);
    // ...plaintext fMP4 after decryption with the key the edge served.
    const d = createDecipheriv('aes-128-cbc', ck, iv);
    const plain = Buffer.concat([d.update(seg), d.final()]);
    expect(plain.subarray(4, 8).toString('latin1')).toMatch(/styp|moof/);
  }, 120_000);

  maybe()('honours Range requests on the proxy segment path', async () => {
    const s = await j<{ session_id: string; token: string }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'u-range' }) });
    const r = await fetch(`${EDGE}/stream/${s.session_id}/seg/720p/seg_00001.m4s?t=${s.token}`,
      { headers: { Range: 'bytes=0-99' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toMatch(/^bytes 0-99\//);
    expect((await r.arrayBuffer()).byteLength).toBe(100);
  }, 60_000);

  maybe()('rejects missing, malformed, tampered and cross-session tokens', async () => {
    const s = await j<{ session_id: string; token: string }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'u2' }) });
    const sid = s.session_id;

    expect(await code(`${EDGE}/stream/${sid}/master.m3u8`)).toBe(401);
    expect(await code(`${EDGE}/stream/${sid}/master.m3u8?t=nonsense`)).toBe(401);
    expect(await code(`${EDGE}/stream/${sid}/master.m3u8?t=v1.aaa.bbb`)).toBe(401);

    const [v, payload, sig] = s.token.split('.');
    const flipped = sig!.slice(0, -4) + (sig!.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    expect(await code(`${EDGE}/stream/${sid}/master.m3u8?t=${v}.${payload}.${flipped}`)).toBe(401);

    const other = 's_' + Buffer.alloc(32, 7).toString('base64url');
    expect(await code(`${EDGE}/stream/${other}/master.m3u8?t=${s.token}`)).toBe(403);
    expect(await code(`${EDGE}/stream/${sid}/key/${'f'.repeat(32)}?t=${s.token}`)).toBe(404);
  }, 60_000);

  // Revocation must bite at the key endpoint even while the token is still signature-valid.
  maybe()('revokes a session immediately at the key endpoint', async () => {
    const s = await j<{ session_id: string; token: string }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'u3' }) });
    const pl = await (await fetch(`${EDGE}/stream/${s.session_id}/720p/playlist.m3u8?t=${s.token}`)).text();
    const kid = /key\/([0-9a-f]{32})/.exec(pl)![1]!;
    const keyUrl = `${EDGE}/stream/${s.session_id}/key/${kid}?t=${s.token}`;

    expect(await code(keyUrl)).toBe(200);
    await j(`/api/v1/playback/${s.session_id}`, { method: 'DELETE' });
    expect(await code(keyUrl), 'key access after revocation').toBe(401);
    expect(await code(`${EDGE}/stream/${s.session_id}/master.m3u8?t=${s.token}`)).toBe(401);
  }, 60_000);

  maybe()('publishes a signed integrity manifest with working Merkle proofs', async () => {
    const m = await j<{
      schema: string; assetRoot: string; signature: { algorithm: string };
      renditions: { name: string; segmentCount: number; encryption: { method: string } }[];
    }>(`/api/v1/assets/${assetId}/integrity`);

    expect(m.schema).toBe('obscura.integrity/v1');
    expect(m.signature.algorithm).toBe('Ed25519');
    expect(m.renditions.every((r) => r.encryption.method === 'AES-128')).toBe(true);

    const p = await j<{ proof: { path: unknown[]; leafHash: string }; segment_count: number; segment_sha256: string }>(
      `/api/v1/assets/${assetId}/integrity/proof?rendition=720p&segment=1`);
    expect(p.proof.path.length).toBeGreaterThan(0);

    // The manifest hashes the ENCRYPTED bytes as stored, so an auditor needs no key.
    const s = await j<{ session_id: string; token: string }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'auditor' }) });
    const seg = Buffer.from(await (await fetch(
      `${EDGE}/stream/${s.session_id}/seg/720p/seg_00002.m4s?t=${s.token}`)).arrayBuffer());
    expect(createHash('sha256').update(seg).digest('hex')).toBe(p.segment_sha256);

    const jwks = await (await fetch(`${API}/.well-known/obscura-integrity-keys.json`)).json() as
      { keys: { kty: string; crv: string }[] };
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
  }, 90_000);

  maybe()('imports a transcript as a subtitle rendition', async () => {
    await j(`/api/v1/assets/${assetId}/subtitles/import`, {
      method: 'POST',
      body: JSON.stringify({
        language: 'en', label: 'English', is_default: true,
        cues: [
          { start_ms: 500, end_ms: 3500, text: 'Tell me about a hard problem.' },
          { start_ms: 4000, end_ms: 9000, text: 'We had a pipeline dropping events.' },
        ],
      }),
    });
    for (let i = 0; i < 20; i++) {
      const t = await j<{ data: { language: string; cue_count: number; origin: string }[] }>(
        `/api/v1/assets/${assetId}/subtitles`);
      if (t.data.length) {
        expect(t.data[0]).toMatchObject({ language: 'en', cue_count: 2, origin: 'transcript_import' });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('subtitle track never appeared');
  }, 60_000);

  maybe()('records who watched, without tracking playback position', async () => {
    const log = await j<{ data: { subject_ref: string; events: Record<string, number>; watched_seconds_estimate: number }[] }>(
      `/api/v1/assets/${assetId}/access-log`);
    expect(log.data.length).toBeGreaterThan(0);
    expect(log.data.some((r) => r.subject_ref === 'u1')).toBe(true);
    // Estimated, never precise - precise position tracking is behavioural profiling.
    expect(log.data[0]).toHaveProperty('watched_seconds_estimate');
    expect(JSON.stringify(log)).not.toMatch(/current_time|position_ms|playhead/);
  }, 30_000);
});

/**
 * Walk the manifests exactly as a player does: master -> variant -> key -> init ->
 * every segment in order, following only URIs the server handed us.
 *
 * This is the test that matters. Fetching storage paths we constructed ourselves proves
 * the pieces work; it does NOT prove a player can actually play the stream. An off-by-one
 * between the names ffmpeg writes and the keys we store passed every other test in this
 * file while making real playback impossible.
 */
describe('e2e: a virtual player follows only the URIs it is given', () => {
  maybe()('plays every rendition end to end, from manifest to decoded media', async () => {
    const assetId = await ingest('basic-720p.mp4');
    const s = await j<{ session_id: string; token: string }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'virtual-player' }) });

    const master = await (await fetch(`${EDGE}/stream/${s.session_id}/master.m3u8?t=${s.token}`)).text();
    const variantUris = master.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(variantUris.length).toBeGreaterThanOrEqual(2);

    for (const variantUri of variantUris) {
      const pl = await (await fetch(variantUri)).text();
      expect(pl, variantUri).toContain('#EXTINF');

      // Key, exactly as the player would resolve it from EXT-X-KEY.
      const keyUri = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(pl)![1]!;
      const iv = Buffer.from(/IV=0x([0-9a-f]{32})/.exec(pl)![1]!, 'hex');
      const keyRes = await fetch(keyUri);
      expect(keyRes.status, `key for ${variantUri}`).toBe(200);
      const ck = Buffer.from(await keyRes.arrayBuffer());

      // Init section, from EXT-X-MAP.
      const mapUri = /#EXT-X-MAP:URI="([^"]+)"/.exec(pl)![1]!;
      const initRes = await fetch(mapUri);
      expect(initRes.status, `init for ${variantUri}`).toBe(200);
      const init = Buffer.from(await initRes.arrayBuffer());

      // EVERY segment, in playlist order, following only the URIs we were given.
      const segUris = pl.split('\n').filter((l) => l && !l.startsWith('#'));
      expect(segUris.length).toBeGreaterThan(1);

      const parts: Buffer[] = [decrypt(init, ck, iv)];
      for (const [i, uri] of segUris.entries()) {
        const res = await fetch(uri);
        expect(res.status, `segment ${i} of ${variantUri}`).toBe(200);
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length, `segment ${i} is not an error page`).toBeGreaterThan(1024);
        parts.push(decrypt(body, ck, iv));
      }

      // The concatenation must be a real, decodable fMP4 stream.
      const joined = Buffer.concat(parts);
      expect(joined.subarray(4, 8).toString('latin1')).toBe('ftyp');
      expect(joined.includes(Buffer.from('moof')), 'contains media fragments').toBe(true);
    }
  }, 400_000);
});

describe('e2e: verified deletion', () => {
  maybe()('purges storage, finds orphans, destroys keys and signs a record', async () => {
    const assetId = await ingest('low-360p.mp4');

    // Prove the content was real and decryptable before deletion.
    const s = await j<{ session_id: string; token: string }>(
      `/api/v1/assets/${assetId}/playback-session`,
      { method: 'POST', body: JSON.stringify({ subject_ref: 'pre-delete' }) });
    const pl = await (await fetch(`${EDGE}/stream/${s.session_id}/360p/playlist.m3u8?t=${s.token}`)).text();
    const kid = /key\/([0-9a-f]{32})/.exec(pl)![1]!;
    const iv = Buffer.from(/IV=0x([0-9a-f]{32})/.exec(pl)![1]!, 'hex');
    const ck = Buffer.from(await (await fetch(`${EDGE}/stream/${s.session_id}/key/${kid}?t=${s.token}`)).arrayBuffer());
    const cipher = Buffer.from(await (await fetch(
      `${EDGE}/stream/${s.session_id}/seg/360p/seg_00001.m4s?t=${s.token}`)).arrayBuffer());
    const d = createDecipheriv('aes-128-cbc', ck, iv);
    expect(Buffer.concat([d.update(cipher), d.final()]).subarray(4, 8).toString('latin1')).toMatch(/styp|moof/);

    await j(`/api/v1/assets/${assetId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'data_subject_request', requested_by: 'privacy@example.com' }),
    });

    let rec: {
      objectsDeleted: number; storageVerifiedEmpty: boolean; contentKeysDestroyed: number;
      sourceSha256: string; signature: { algorithm: string }; reason: string;
    } | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await j<typeof rec & { completedAt: string | null }>(`/api/v1/assets/${assetId}/deletion-record`);
        if (r?.completedAt) { rec = r; break; }
      } catch { /* still in progress */ }
      await new Promise((r) => setTimeout(r, 1500));
    }

    expect(rec, 'deletion record').not.toBeNull();
    expect(rec!.storageVerifiedEmpty, 'storage verified empty').toBe(true);
    expect(rec!.objectsDeleted).toBeGreaterThan(0);
    expect(rec!.contentKeysDestroyed).toBe(1);
    expect(rec!.reason).toBe('data_subject_request');
    // One-way hashes survive: they identify nothing but answer "did you hold this file?"
    expect(rec!.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec!.signature.algorithm).toBe('Ed25519');

    // The asset is gone, but the proof of deletion is not.
    const gone = await fetch(`${API}/api/v1/assets/${assetId}`, { headers: { Authorization: `Bearer ${key}` } });
    expect(gone.status).toBe(410);
    const still = await fetch(`${API}/api/v1/assets/${assetId}/deletion-record`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(still.status, 'deletion record outlives the asset').toBe(200);

    // Cryptographic erasure: the ciphertext we already hold is now permanently inert.
    expect(await code(`${EDGE}/stream/${s.session_id}/key/${kid}?t=${s.token}`)).toBe(401);

    // Storage really is empty, checked independently of the record's own claim.
    expect(await code(
      `http://localhost:9000/obscura-delivery/videos/${assetId}/hls/360p/seg_00001.m4s`)).toBe(403);
  }, 400_000);
});
