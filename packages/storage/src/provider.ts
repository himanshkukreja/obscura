import type { Readable } from 'node:stream';

export interface ByteRange { start: number; end?: number }

export interface PutOptions {
  contentType?: string;
  contentLength?: number;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface PutResult { key: string; etag: string | null }

export interface GetResult {
  body: Readable;
  contentLength: number | null;
  contentType: string | null;
  contentRange: string | null;
  etag: string | null;
}

export interface ObjectMetadata {
  key: string;
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

export interface ListPage {
  objects: { key: string; size: number }[];
  cursor: string | null;
}

export interface MultipartHandle { key: string; uploadId: string }

/**
 * The storage contract. Deliberately excludes bucket creation, ACLs, lifecycle policies,
 * tagging and versioning: those are operator concerns, and including them would tie us to
 * per-vendor semantics.
 */
export interface StorageProvider {
  readonly name: string;
  put(bucket: string, key: string, body: Readable | Buffer, opts?: PutOptions): Promise<PutResult>;
  get(bucket: string, key: string, range?: ByteRange): Promise<GetResult>;
  head(bucket: string, key: string): Promise<ObjectMetadata | null>;
  delete(bucket: string, keys: string[]): Promise<number>;
  list(bucket: string, prefix: string, cursor?: string): Promise<ListPage>;
  signedUrl(
    bucket: string,
    key: string,
    op: 'GET' | 'PUT',
    ttlSeconds: number,
    opts?: { contentType?: string },
  ): Promise<string>;
  createMultipart(bucket: string, key: string, contentType?: string): Promise<MultipartHandle>;
  signPartUrl(h: MultipartHandle, bucket: string, partNumber: number, ttl: number): Promise<string>;
  completeMultipart(
    h: MultipartHandle,
    bucket: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(h: MultipartHandle, bucket: string): Promise<void>;
}

/** Collect every key under a prefix, following pagination to the end. */
export async function listAll(
  storage: StorageProvider,
  bucket: string,
  prefix: string,
): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(bucket, prefix, cursor);
    out.push(...page.objects);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return out;
}
