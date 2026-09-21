import { useEffect, useRef, useState, useCallback } from 'react';
import Hls, { type Level, Events, ErrorTypes } from 'hls.js';
import { Watermark } from './Watermark.tsx';
import { heartbeat, ApiError } from './api.ts';
import type { PlaybackSession } from './types.ts';

type Status =
  | { kind: 'loading' }
  | { kind: 'playing' }
  | { kind: 'ended'; reason: string; detail: string };

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function Player({ session, onClose }: { session: PlaybackSession; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const tokenRef = useRef(session.token);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);
  const [activeLevel, setActiveLevel] = useState<Level | null>(null);
  const [speed, setSpeed] = useState(1);

  const end = useCallback((reason: string, detail: string) => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setStatus({ kind: 'ended', reason, detail });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!Hls.isSupported()) {
      // Native HLS: works, but cannot attach headers, which is exactly why Obscura puts
      // the token in the URL rather than in an Authorization header.
      video.src = session.manifest_url;
      setStatus({ kind: 'playing' });
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // Keep the buffer modest so an expiring token is noticed quickly rather than
      // surfacing minutes later as a mysterious stall.
      maxBufferLength: 30,
      // hls.js assumes 500 kbps until it has measured the connection, which parks it on
      // the bottom rung for the first several seconds - long enough to look like the
      // stream is simply low quality. Start from a realistic estimate and let ABR correct
      // downward if the connection is genuinely poor.
      abrEwmaDefaultEstimate: 3_000_000,
      // Never cap quality to the size of the <video> element. A player in a small box
      // would otherwise be pinned to a low rendition even on a fast connection.
      capLevelToPlayerSize: false,
      startLevel: -1,
      xhrSetup: (xhr, url) => {
        // Swap in the freshest token on every request, including key fetches.
        const u = new URL(url, window.location.origin);
        if (u.searchParams.has('t')) {
          u.searchParams.set('t', tokenRef.current);
          xhr.open('GET', u.toString(), true);
        }
      },
    });
    hlsRef.current = hls;

    hls.on(Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(data.levels);
      setStatus({ kind: 'playing' });
      void video.play().catch(() => {/* autoplay policy; user can press play */});
    });
    hls.on(Events.LEVEL_SWITCHED, (_e, data) => {
      setLevel(hls.autoLevelEnabled ? -1 : data.level);
      setActiveLevel(hls.levels[data.level] ?? null);
    });

    hls.on(Events.ERROR, (_e, data) => {
      const http = data.response?.code;
      // A 401/403 on a key or manifest fetch means the session ended - say so plainly
      // instead of showing a generic media error.
      if (http === 401 || http === 403) {
        end('Session ended', 'Your viewing session expired or was revoked. Request a new one to continue.');
        return;
      }
      if (!data.fatal) return;
      if (data.type === ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else end('Playback failed', data.details ?? 'Unrecoverable media error');
    });

    hls.loadSource(session.manifest_url);
    hls.attachMedia(video);

    return () => { hls.destroy(); hlsRef.current = null; };
  }, [session.manifest_url, end]);

  // Refresh the token before it expires. The player should not have to reason about
  // lifetimes: the server tells it when to come back.
  useEffect(() => {
    let cancelled = false;
    let timer: number;

    const beat = async () => {
      try {
        const r = await heartbeat(session.session_id);
        if (cancelled) return;
        tokenRef.current = r.token;
        timer = window.setTimeout(beat, r.refresh_after * 1000);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
          end('Session ended', e.code === 'session_revoked'
            ? 'This session was revoked.'
            : 'This session expired.');
        } else {
          timer = window.setTimeout(beat, 15_000);
        }
      }
    };
    timer = window.setTimeout(beat, session.refresh_after * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session.session_id, session.refresh_after, end]);

  if (status.kind === 'ended') {
    return (
      <div className="wrap card ended">
        <h2>{status.reason}</h2>
        <p>{status.detail}</p>
        <button className="primary" onClick={onClose}>Back</button>
      </div>
    );
  }

  return (
    <div className="wrap player-view">
      <div className="stage">
        <video
          ref={videoRef}
          controls
          playsInline
          controlsList="nodownload"
          disablePictureInPicture
          onContextMenu={(e) => e.preventDefault()}
          className="video"
        />
        <Watermark session={session} />
        {status.kind === 'loading' && <div className="loading">Loading…</div>}
      </div>

      <div className="controls">
        <label>
          Quality{' '}
          <select
            value={level}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLevel(v);
              if (hlsRef.current) hlsRef.current.currentLevel = v;
            }}
          >
            <option value={-1}>Auto</option>
            {levels.map((l, i) => (
              <option key={i} value={i}>{l.height}p</option>
            ))}
          </select>
        </label>

        <label>
          Speed{' '}
          <select
            value={speed}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSpeed(v);
              if (videoRef.current) videoRef.current.playbackRate = v;
            }}
          >
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>

        <button className="ghost" onClick={() => videoRef.current?.requestFullscreen?.()}>Fullscreen</button>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>

      <p className="note">
        {activeLevel && (
          <>playing <strong>{activeLevel.height}p</strong>
          {' '}({Math.round((activeLevel.bitrate ?? 0) / 1000)} kbps) · </>
        )}
        session <code>{session.session_id.slice(0, 14)}…</code> · expires{' '}
        {new Date(session.expires_at).toLocaleTimeString()}
      </p>
    </div>
  );
}
