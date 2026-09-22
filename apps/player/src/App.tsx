import { useEffect, useState, useCallback, useRef } from 'react';
import { Player } from './Player.tsx';
import {
  listAssets, createSession, upload, deleteAsset, mintKey, getKey, setKey,
  getIntegrity, getAccessLog, ApiError,
} from './api.ts';
import type { AssetSummary, PlaybackSession } from './types.ts';

type Upload = { name: string; phase: 'uploading' | 'committing'; fraction: number };

const TERMINAL = ['READY', 'FAILED', 'DELETED'];

export function App() {
  const [key, setKeyState] = useState(getKey());
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [viewer, setViewer] = useState(localStorage.getItem('obscura_viewer') ?? 'recruiter@acme.com');
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!getKey()) return;
    try {
      setAssets((await listAssets()).data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError
        ? (e.status === 401 ? 'That API key was rejected. Generate a new one below.' : `${e.code}: ${e.message}`)
        : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, key]);

  useEffect(() => {
    if (!assets.some((a) => !TERMINAL.includes(a.status))) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [assets, refresh]);

  const saveKey = (k: string) => { setKey(k.trim()); setKeyState(k.trim()); };

  const generate = async () => {
    setMinting(true); setError(null);
    try { saveKey(await mintKey()); }
    catch {
      setError('Key bootstrap is disabled on this server (ALLOW_CLIENT_BOOTSTRAP is not true). Mint one with the command below and paste it in.');
    } finally { setMinting(false); }
  };

  const doUpload = async (files: FileList | File[]) => {
    setError(null);
    for (const file of Array.from(files)) {
      const entry: Upload = { name: file.name, phase: 'uploading', fraction: 0 };
      setUploads((u) => [...u, entry]);
      const patch = (p: Partial<Upload>) =>
        setUploads((u) => u.map((x) => (x === entry ? Object.assign(entry, p) : x)).slice());
      try {
        await upload(file, file.name, (f) => patch({ fraction: f }));
        patch({ phase: 'committing', fraction: 1 });
        await refresh();
      } catch (e) {
        setError(`${file.name}: ${e instanceof ApiError ? e.message : String(e)}`);
      } finally {
        setUploads((u) => u.filter((x) => x !== entry));
      }
    }
    await refresh();
  };

  const play = async (a: AssetSummary) => {
    setError(null);
    try {
      setSession(await createSession(a.asset_id, `viewer:${viewer}`, viewer));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  const remove = async (a: AssetSummary) => {
    if (!confirm(`Delete "${a.title ?? a.asset_id}"?\n\nThis runs a verified purge: every object is enumerated from storage and removed, the content key is destroyed, and a signed deletion record is written. It cannot be undone.`)) return;
    try { await deleteAsset(a.asset_id); await refresh(); }
    catch (e) { setError(String(e)); }
  };

  if (session) {
    return <Player session={session} onClose={() => { setSession(null); void refresh(); }} />;
  }

  return (
    <div className="wrap">
      <header className="masthead">
        <div>
          <h1>Obscura</h1>
          <p className="tagline">Private video delivery without handing out the original file.</p>
        </div>
        <span className="pill">reference player</span>
      </header>

      {!key && (
        <section className="card onboard">
          <h2>Start here</h2>
          <p>
            This player needs an API key to talk to the control plane. In a real integration
            your backend holds this key and the browser never sees it.
          </p>
          <div className="row">
            <button className="primary" onClick={() => void generate()} disabled={minting}>
              {minting ? 'Generating…' : 'Generate a key'}
            </button>
            <span className="muted">or paste one below</span>
          </div>
          <details>
            <summary>Mint one from the command line instead</summary>
            <pre>{`curl -sX POST localhost:3001/api/v1/admin/clients \\
  -H 'Content-Type: application/json' -d '{"name":"local"}'`}</pre>
          </details>
        </section>
      )}

      <section className="card">
        <h2>Connection</h2>
        <div className="fields">
          <label>
            <span>API key</span>
            <input
              value={key} placeholder="obs_…" spellCheck={false}
              onChange={(e) => saveKey(e.target.value)}
            />
          </label>
          <label>
            <span>Viewer identity</span>
            <input
              value={viewer} spellCheck={false}
              onChange={(e) => { setViewer(e.target.value); localStorage.setItem('obscura_viewer', e.target.value); }}
            />
            <small>Rendered into the watermark. Identifies who is watching — not which asset.</small>
          </label>
        </div>
        {key && <p className="warn">
          A production integration never ships this key to a browser. It lives here only so
          the demo runs without a second service.
        </p>}
      </section>

      <section
        className={`card drop ${key ? '' : 'disabled'}`}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
        onDragLeave={(e) => e.currentTarget.classList.remove('over')}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('over');
          if (key && e.dataTransfer.files.length) void doUpload(e.dataTransfer.files);
        }}
        onClick={() => key && fileRef.current?.click()}
      >
        <input
          ref={fileRef} type="file" accept="video/*" multiple hidden
          onChange={(e) => { if (e.target.files?.length) void doUpload(e.target.files); e.target.value = ''; }}
        />
        <div className="drop-inner">
          <strong>{key ? 'Drop a video here, or click to choose' : 'Add an API key first'}</strong>
          <span className="muted">
            {key ? 'MP4, MOV, MKV, WebM, AVI, M4V' : 'Uploading is disabled until the connection above is set'}
          </span>
        </div>
      </section>

      {uploads.map((u, i) => (
        <div className="card progress-card" key={i}>
          <div className="row between">
            <span>{u.name}</span>
            <span className="muted">{u.phase === 'uploading' ? `${Math.round(u.fraction * 100)}%` : 'committing…'}</span>
          </div>
          <div className="bar"><div style={{ width: `${u.fraction * 100}%` }} /></div>
          <small className="muted">Uploading straight to object storage — these bytes never pass through the API.</small>
        </div>
      ))}

      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>Assets</h2>
        {assets.length === 0
          ? <p className="muted empty">Nothing here yet.</p>
          : (
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th><th className="col-status">Status</th>
                  <th>Size</th><th>Duration</th><th />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <Row
                    key={a.asset_id} asset={a}
                    onPlay={() => void play(a)}
                    onDelete={() => void remove(a)}
                    onInspect={() => setInspecting(inspecting === a.asset_id ? null : a.asset_id)}
                    expanded={inspecting === a.asset_id}
                  />
                ))}
              </tbody>
            </table>
            </div>
          )}
      </section>

      <footer className="muted">
        Obscura cannot stop an authorised viewer capturing what they are allowed to watch.
        It keeps the original private, makes every grant short-lived and revocable, records
        who watched what, and makes deletion provable.
      </footer>
    </div>
  );
}

type Integrity = Awaited<ReturnType<typeof getIntegrity>>;
type AccessLog = Awaited<ReturnType<typeof getAccessLog>>;

const bytes = (n: number | null | undefined) => {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};
const when = (t: string | null | undefined) => (t ? new Date(t).toLocaleString() : '—');
const secs = (n: number) => (n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${n % 60}s`);

/** Long hex is unreadable inline and rarely needed in full - show the ends, copy the whole. */
function Hash({ value, label }: { value: string | null; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  return (
    <button
      type="button"
      className="hashchip"
      title={`${label}: ${value} (click to copy)`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true); setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <code>{copied ? 'copied' : `${value.slice(0, 10)}…${value.slice(-6)}`}</code>
    </button>
  );
}

function Detail({ asset: a, integ, log, failed }: {
  asset: AssetSummary; integ: Integrity | null; log: AccessLog | null; failed: boolean;
}) {
  if (failed) return <p className="muted">Details are unavailable for this asset.</p>;
  if (!integ && !log) return <p className="muted">Loading…</p>;
  const viewers = log?.data ?? [];
  return (
    <div className="detail-grid">
      <section>
        <h4>Provenance</h4>
        {/* The point of the integrity manifest is that it is checkable, so show what was
            signed and by which key rather than asserting "verified". */}
        <dl className="kv">
          <dt>Source SHA-256</dt><dd><Hash value={integ?.source.sha256 ?? a.source_sha256} label="Source SHA-256" /></dd>
          <dt>Asset root</dt><dd><Hash value={integ?.assetRoot ?? a.asset_root} label="Merkle root" /></dd>
          <dt>Signature</dt>
          <dd>{integ?.signature
            ? <>{integ.signature.algorithm} <span className="muted">· {integ.signature.keyId}</span></>
            : <span className="muted">unsigned</span>}</dd>
          <dt>Pipeline</dt>
          <dd>{integ ? <>v{integ.pipeline.version} <span className="muted">· ffmpeg {integ.pipeline.ffmpeg}</span></> : '—'}</dd>
          <dt>Original</dt>
          <dd>{bytes(integ?.source.size ?? a.size)} <span className="muted">{integ?.source.contentType ?? a.content_type ?? ''}</span></dd>
        </dl>
      </section>

      <section>
        <h4>Lifecycle</h4>
        <dl className="kv">
          <dt>Created</dt><dd>{when(a.created_at)}</dd>
          <dt>Ready</dt><dd>{when(a.ready_at)}</dd>
          <dt>Expires</dt>
          <dd>{a.expires_at
            ? when(a.expires_at)
            : <span className="muted">never — retained until deleted</span>}</dd>
        </dl>
      </section>

      <section className="wide">
        <h4>Renditions</h4>
        {integ?.renditions.length ? (
          <table className="mini">
            <thead><tr><th>Rung</th><th>Resolution</th><th>Segments</th><th>Encryption</th></tr></thead>
            <tbody>
              {integ.renditions.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="muted">{r.width}×{r.height}</td>
                  <td className="muted">{r.segmentCount}</td>
                  <td>{r.encryption.method === 'NONE'
                    ? <span className="warn">not encrypted</span>
                    : <span className="ok">{r.encryption.method}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No renditions yet.</p>}
      </section>

      <section className="wide">
        <h4>Who watched <span className="muted">({viewers.length})</span></h4>
        {viewers.length ? (
          <table className="mini">
            <thead><tr><th>Viewer</th><th>Started</th><th>Watched</th><th>Keys</th><th /></tr></thead>
            <tbody>
              {viewers.map((v) => (
                <tr key={v.session_id}>
                  <td>{v.subject_ref}</td>
                  <td className="muted">{when(v.started_at)}</td>
                  {/* Estimated from heartbeats: precise position tracking would be
                      behavioural profiling of the person on camera. */}
                  <td className="muted" title="Estimated from heartbeats">~{secs(v.watched_seconds_estimate)}</td>
                  <td className="muted">{v.events?.['key'] ?? 0}</td>
                  <td>{v.revoked_at ? <span className="pill danger">revoked</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">Nobody has opened this recording.</p>}
      </section>
    </div>
  );
}

function Row({ asset: a, onPlay, onDelete, onInspect, expanded }: {
  asset: AssetSummary; onPlay: () => void; onDelete: () => void; onInspect: () => void; expanded: boolean;
}) {
  const [integ, setInteg] = useState<Integrity | null>(null);
  const [log, setLog] = useState<AccessLog | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    void (async () => {
      const [i, l] = await Promise.all([
        getIntegrity(a.asset_id).catch(() => null),
        getAccessLog(a.asset_id).catch(() => null),
      ]);
      setInteg(i); setLog(l);
      // Only a genuine failure when neither call returned; an asset that is still
      // processing legitimately has no integrity manifest yet.
      setFailed(!i && !l);
    })();
  }, [expanded, a.asset_id]);

  return (
    <>
      <tr>
        <td className="title">{a.title ?? <code>{a.asset_id.slice(0, 8)}</code>}</td>
        <td className="col-status"><Status asset={a} /></td>
        <td className="muted">{a.width ? `${a.width}×${a.height}` : '—'}</td>
        <td className="muted">{a.duration_ms ? `${Math.round(a.duration_ms / 1000)}s` : '—'}</td>
        <td className="actions">
          <button className="primary" disabled={a.status !== 'READY'} onClick={onPlay}>Play</button>
          <button className="ghost" onClick={onInspect}>{expanded ? 'Hide' : 'Inspect'}</button>
          <button className="ghost danger" onClick={onDelete}>Delete</button>
        </td>
      </tr>
      {expanded && (
        <tr className="detail">
          <td colSpan={5}><Detail asset={a} integ={integ} log={log} failed={failed} /></td>
        </tr>
      )}
    </>
  );
}

function Status({ asset: a }: { asset: AssetSummary }) {
  if (a.status === 'FAILED') {
    return <span className="badge FAILED" title={a.error_code ?? ''}>FAILED{a.error_code ? ` · ${a.error_code}` : ''}</span>;
  }
  if (TERMINAL.includes(a.status)) return <span className={`badge ${a.status}`}>{a.status}</span>;
  return <span className="badge working"><i className="spin" />{a.status}</span>;
}
