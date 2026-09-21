import { ErrorCodes, ObscuraError, parseSessionId, type PlaybackTokenClaims } from '@obscura/shared';
import { verifyToken, assertAsset } from '@obscura/auth';
import type { SessionRow } from '@obscura/db';
import type { Deps } from './deps.ts';

export interface Authorized { session: SessionRow; claims: PlaybackTokenClaims }

/**
 * Stateless validation: signature only, no database round trip. This is what lets segment
 * and manifest authorization happen at a CDN edge.
 *
 * The cost is a revocation window equal to the token TTL. It is compensated by
 * `authorizeStateful`, used by the key endpoint, which always checks the database - so a
 * revoked session loses the next content key immediately even while a segment token is
 * still signature-valid.
 */
export function authorizeStateless(deps: Deps, sidStr: string, token: string | undefined): {
  sessionId: Buffer; claims: PlaybackTokenClaims;
} {
  const sessionId = parseSessionId(sidStr);
  if (!sessionId) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Malformed session id', { status: 400 });
  }
  if (!token) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Missing playback token', { status: 401 });
  }
  const claims = verifyToken(deps.tokenPublic, token);
  if (claims.sid !== sessionId.toString('base64url')) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Token is bound to a different session', {
      status: 403,
    });
  }
  return { sessionId, claims };
}

/** Full check, including revocation. The key endpoint is the choke point. */
export async function authorizeStateful(
  deps: Deps, sidStr: string, token: string | undefined,
): Promise<Authorized> {
  const { sessionId, claims } = authorizeStateless(deps, sidStr, token);

  const session = await deps.repos.sessions.byId(sessionId);
  if (!session) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Session not found', { status: 401 });
  }
  if (session.revoked_at) {
    await deps.repos.sessions.event(sessionId, session.asset_id, 'denied', { reason: 'revoked' });
    throw new ObscuraError(ErrorCodes.SESSION_REVOKED, 'Session has been revoked', { status: 401 });
  }
  if (session.expires_at.getTime() <= Date.now()) {
    await deps.repos.sessions.event(sessionId, session.asset_id, 'denied', { reason: 'expired' });
    throw new ObscuraError(ErrorCodes.SESSION_EXPIRED, 'Session has expired', { status: 401 });
  }
  // Bumping token_epoch invalidates every token already issued for the session.
  if (claims.ep !== session.token_epoch) {
    throw new ObscuraError(ErrorCodes.INVALID_TOKEN, 'Token has been superseded', { status: 401 });
  }
  assertAsset(claims, session.asset_id);

  return { session, claims };
}
