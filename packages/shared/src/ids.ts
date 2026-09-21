import { randomBytes, randomUUID } from 'node:crypto';

/**
 * UUIDv7 - time-ordered, so it indexes well without leaking a sequential count.
 * Node's randomUUID is v4; we build v7 by hand.
 */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | (b[6]! & 0x0f); // version 7
  b[8] = 0x80 | (b[8]! & 0x3f); // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export { randomUUID };

/** 256 bits of CSPRNG. A session id is a capability: never ordered, never guessable. */
export function sessionId(): Buffer {
  return randomBytes(32);
}

/** base64url without padding - safe in URLs, manifests and headers. */
export function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}
export function unb64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function formatSessionId(id: Buffer): string {
  return `s_${b64u(id)}`;
}
export function parseSessionId(s: string): Buffer | null {
  if (!s.startsWith('s_')) return null;
  try {
    const b = unb64u(s.slice(2));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** Short, human-quotable identifier for watermarks and support tickets. */
export function shortId(id: string | Buffer): string {
  const s = Buffer.isBuffer(id) ? id.toString('hex') : id.replace(/-/g, '');
  return s.slice(0, 8);
}
