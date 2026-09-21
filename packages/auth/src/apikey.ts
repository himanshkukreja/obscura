import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { unauthorized } from '@obscura/shared';
import type { ApiClientRepository, ApiClientRow } from '@obscura/db';

const scrypt = promisify(scryptCb) as (p: string | Buffer, s: Buffer, k: number) => Promise<Buffer>;
const N = 32;

/**
 * Key format: obs_<prefix>_<secret>
 * The prefix is stored in clear for O(1) lookup and log correlation; the secret is only
 * ever stored as a salted hash.
 */
export interface GeneratedKey { full: string; prefix: string; hash: string }

export async function generateApiKey(): Promise<GeneratedKey> {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return { full: `obs_${prefix}_${secret}`, prefix, hash: await hashSecret(secret) };
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt, N);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(secret, Buffer.from(saltB64, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const m = /^obs_([0-9a-f]{12})_([A-Za-z0-9_-]{16,})$/.exec(raw.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

export async function authenticate(
  repo: ApiClientRepository, authorization: string | undefined,
): Promise<ApiClientRow> {
  const raw = bearer(authorization);
  if (!raw) throw unauthorized('Missing Authorization header');
  const parsed = parseApiKey(raw);
  if (!parsed) throw unauthorized('Malformed API key');
  const client = await repo.byPrefix(parsed.prefix);
  // Hash even on a miss, so a nonexistent prefix and a wrong secret cost the same time.
  const ok = await verifySecret(parsed.secret, client?.key_hash ?? (await hashSecret('x')));
  if (!client || !ok) throw unauthorized('Invalid API key');
  return client;
}
