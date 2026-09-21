import { useEffect, useState } from 'react';
import type { PlaybackSession } from './types.ts';

type Pos = NonNullable<PlaybackSession['watermark']>['position'];

const CORNERS: Record<string, React.CSSProperties> = {
  'top-left': { top: '4%', left: '4%' },
  'top-right': { top: '4%', right: '4%' },
  'bottom-left': { bottom: '10%', left: '4%' },
  'bottom-right': { bottom: '10%', right: '4%' },
  center: { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
};

const CYCLE: Pos[] = ['bottom-right', 'top-left', 'center', 'bottom-left', 'top-right'];

/**
 * Overlay watermarking.
 *
 * Deterrence, not prevention. It appears in a screen recording, which is its entire value.
 * It is removable in seconds by anyone who opens devtools, and it is absent from a file
 * reassembled from downloaded segments. The docs say so; so does this comment.
 */
export function Watermark({ session }: { session: PlaybackSession }) {
  const wm = session.watermark;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!wm?.enabled) return;
    if (wm.position !== 'dynamic' && wm.position !== 'random') return;
    const id = setInterval(() => setTick((t) => t + 1), wm.interval_seconds * 1000);
    return () => clearInterval(id);
  }, [wm?.enabled, wm?.position, wm?.interval_seconds]);

  if (!wm?.enabled) return null;

  // Deterministic schedule seeded from the session, so a recording can be cross-checked
  // against the expected sequence. That is why `dynamic` is preferred over `random`.
  let seed = 0;
  for (const c of session.session_id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;

  const pos: Pos =
    wm.position === 'dynamic' ? CYCLE[(seed + tick) % CYCLE.length]!
    : wm.position === 'random' ? CYCLE[Math.floor(Math.random() * CYCLE.length)]!
    : wm.position;

  const style: React.CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    color: '#fff',
    opacity: wm.opacity,
    fontSize: `${wm.font_size_vh}vh`,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    textShadow: '0 1px 3px rgba(0,0,0,.9)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    zIndex: 5,
    ...CORNERS[pos],
  };

  if (wm.tiled) {
    return (
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 5 }}>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} style={{
            position: 'absolute',
            top: `${(i % 4) * 25 + 6}%`,
            left: `${Math.floor(i / 4) * 33 + 4}%`,
            color: '#fff', opacity: wm.opacity * 0.7,
            fontSize: `${wm.font_size_vh * 0.8}vh`,
            fontFamily: 'ui-monospace, monospace',
            transform: 'rotate(-20deg)', whiteSpace: 'nowrap', userSelect: 'none',
          }}>{wm.text}</div>
        ))}
      </div>
    );
  }

  return <div style={style}>{wm.text}</div>;
}
