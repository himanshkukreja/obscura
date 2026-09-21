import type { AssetSummary, PlaybackSession } from './types.ts';

/**
 * In a real integration none of this runs in the browser: your backend holds the API key
 * and mints sessions server-to-server. The reference player does it client-side only so
 * the demo works without a second service, and says so on screen.
 */
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

export const getKey = () => localStorage.getItem('obscura_key') ?? '';
export const setKey = (k: string) => localStorage.setItem('obscura_key', k);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getKey();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body as { error?: { code?: string; message?: string } };
    throw new ApiError(e?.error?.code ?? String(res.status), e?.error?.message ?? res.statusText, res.status);
  }
  return body as T;
}

/**
 * Only works while ALLOW_CLIENT_BOOTSTRAP=true, which is a development setting. In
 * production this returns 404 and the UI falls back to showing the command to run.
 */
export async function mintKey(): Promise<string> {
  const r = await fetch(`${BASE}/admin/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'reference-player' }),
  });
  if (!r.ok) throw new ApiError('bootstrap_disabled', 'Key bootstrap is disabled on this server', r.status);
  return ((await r.json()) as { api_key: string }).api_key;
}

export const listAssets = () => call<{ data: AssetSummary[] }>('/assets?limit=50');

export const getStatus = (id: string) =>
  call<{
    status: string; progress: number | null; error_code: string | null;
    renditions: { name: string; status: string; progress: number | null }[];
  }>(`/assets/${id}/status`);

export const createSession = (id: string, subjectRef: string, subjectLabel: string) =>
  call<PlaybackSession>(`/assets/${id}/playback-session`, {
    method: 'POST',
    body: JSON.stringify({ subject_ref: subjectRef, subject_label: subjectLabel }),
  });

export const heartbeat = (sid: string) =>
  call<{ token: string; refresh_after: number }>(`/playback/${sid}/heartbeat`, { method: 'POST' });

export const deleteAsset = (id: string) =>
  call<{ asset_id: string }>(`/assets/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason: 'operator', requested_by: 'reference-player' }),
  });

export const getIntegrity = (id: string) =>
  call<{ assetRoot: string; signature: { keyId: string }; renditions: { name: string; segmentCount: number }[] }>(
    `/assets/${id}/integrity`);

export const getAccessLog = (id: string) =>
  call<{ data: { subject_ref: string; started_at: string; events: Record<string, number> }[] }>(
    `/assets/${id}/access-log`);

/** XHR rather than fetch, because fetch gives no upload progress. */
export function upload(
  file: File, title: string, onProgress: (fraction: number) => void,
): Promise<string> {
  return (async () => {
    const created = await call<{ asset_id: string; upload: { url: string; headers: Record<string, string> } }>(
      '/assets', {
        method: 'POST',
        body: JSON.stringify({
          original_filename: file.name, size: file.size,
          content_type: file.type || 'application/octet-stream', title,
        }),
      });

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', created.upload.url, true);
      for (const [k, v] of Object.entries(created.upload.headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: HTTP ${xhr.status}`)));
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      xhr.send(file);
    });

    await call(`/assets/${created.asset_id}/commit`, { method: 'POST' });
    return created.asset_id;
  })();
}
