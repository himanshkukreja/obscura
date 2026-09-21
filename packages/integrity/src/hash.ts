import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export const sha256 = (b: Buffer | string): string =>
  createHash('sha256').update(b).digest('hex');

export const sha256Buf = (b: Buffer | string): Buffer =>
  createHash('sha256').update(b).digest();

export async function sha256File(path: string): Promise<{ hex: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  const s = createReadStream(path);
  for await (const chunk of s) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hex: h.digest('hex'), size };
}

/**
 * A pass-through that hashes while bytes flow, so the source is read exactly once:
 * downloading and hashing are fused rather than sequential.
 */
export class HashingStream extends Transform {
  readonly #hash: Hash = createHash('sha256');
  #size = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error) => void) {
    this.#hash.update(chunk);
    this.#size += chunk.length;
    this.push(chunk);
    cb();
  }
  get digest(): string { return this.#hash.copy().digest('hex'); }
  get size(): number { return this.#size; }
}

export async function hashStream(src: Readable): Promise<{ hex: string; size: number }> {
  const h = new HashingStream();
  await pipeline(src, h, new Transform({ transform(_c, _e, cb) { cb(); } }));
  return { hex: h.digest, size: h.size };
}
