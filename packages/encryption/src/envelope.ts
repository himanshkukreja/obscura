import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObscuraError, ErrorCodes } from '@obscura/shared';
import type { ContentKey, KeyContext, KeyProvider, WrappedKey } from './provider.ts';

/**
 * Envelope encryption: content keys are stored as AES-256-GCM ciphertext, wrapped by a
 * master key that lives outside the database.
 *
 * Deletion note: destroying the wrapped row is what makes every surviving copy of a
 * segment permanently unreadable, including copies in replicas and caches we cannot
 * reach. That is why the delete job destroys rows rather than marking them revoked.
 */
export class EnvelopeKeyProvider implements KeyProvider {
  readonly name = 'envelope';
  readonly #master: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error('Envelope master key must be exactly 32 bytes');
    }
    this.#master = masterKey;
  }

  async generateContentKey(): Promise<ContentKey> {
    return { kid: randomBytes(16), key: randomBytes(16) };
  }

  async wrap(key: Buffer, ctx: KeyContext): Promise<WrappedKey> {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#master, nonce);
    c.setAAD(aad(ctx));
    const ciphertext = Buffer.concat([c.update(key), c.final()]);
    return { kid: ctx.kid, ciphertext, nonce, tag: c.getAuthTag(), provider: this.name };
  }

  async unwrap(w: WrappedKey, ctx: KeyContext): Promise<Buffer> {
    if (w.kid.length !== ctx.kid.length || !timingSafeEqual(w.kid, ctx.kid)) {
      throw new ObscuraError(ErrorCodes.INTERNAL, 'Key identifier mismatch during unwrap');
    }
    try {
      const d = createDecipheriv('aes-256-gcm', this.#master, w.nonce);
      d.setAAD(aad(ctx));
      d.setAuthTag(w.tag);
      return Buffer.concat([d.update(w.ciphertext), d.final()]);
    } catch (e) {
      throw new ObscuraError(ErrorCodes.INTERNAL, 'Content key failed authentication', { cause: e });
    }
  }
}

function aad(ctx: KeyContext): Buffer {
  return Buffer.concat([Buffer.from(ctx.assetId, 'utf8'), Buffer.from('|'), ctx.kid]);
}

/** Per-segment IV. Explicit rather than derived from the media sequence number, so a
 *  segment's decryptability does not depend on its position in a playlist we rewrite. */
export function generateIv(): Buffer { return randomBytes(16); }
