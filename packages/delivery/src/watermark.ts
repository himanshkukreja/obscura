import type { WatermarkPolicy } from '@obscura/shared';

export interface WatermarkContext {
  userLabel: string;
  userRef: string;
  sessionId: string;
  sessionShortId: string;
  assetId: string;
  assetShortId: string;
  orgName: string;
}

const MAX_LEN = 120;

/**
 * Render the overlay string.
 *
 * The default template identifies the VIEWER, not the asset. Watermarking content with
 * its own identifier answers a question you already knew the answer to; attribution needs
 * to say who was watching.
 */
export function renderWatermark(policy: WatermarkPolicy, ctx: WatermarkContext): string {
  const vars: Record<string, string> = {
    'user.label': ctx.userLabel,
    'user.ref': ctx.userRef,
    'session.id': ctx.sessionId,
    'session.short_id': ctx.sessionShortId,
    'asset.id': ctx.assetId,
    'asset.short_id': ctx.assetShortId,
    'org.name': ctx.orgName,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  };
  const out = policy.textTemplate.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) =>
    sanitize(vars[k] ?? ''),
  );
  return out.trim().slice(0, MAX_LEN);
}

/** Strip anything that could break out of a text node or smuggle markup into the player. */
function sanitize(v: string): string {
  return v.replace(/[<>&"'\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic position schedule seeded from the session, so a recording can be
 * cross-checked against the expected sequence. That extra attribution signal is the
 * reason to prefer `dynamic` over `random`.
 */
const CYCLE = ['bottom-right', 'top-left', 'center', 'bottom-left', 'top-right'] as const;

export function positionSchedule(
  policy: WatermarkPolicy, sessionId: string,
): { offset: number; cycle: readonly string[] } {
  let h = 0;
  for (const c of sessionId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { offset: h % CYCLE.length, cycle: CYCLE };
}
