import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectsCommand, ListObjectsV2Command, CreateMultipartUploadCommand,
  UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ObscuraError, ErrorCodes } from '@obscura/shared';
import type {
  StorageProvider, PutOptions, PutResult, GetResult, ObjectMetadata,
  ListPage, ByteRange, MultipartHandle,
} from './provider.ts';

export interface S3Config {
  endpoint?: string | undefined;
  /** Used only for signing URLs handed to clients; defaults to `endpoint`. */
  publicEndpoint?: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function wrap(e: unknown, op: string, key: string): never {
  const name = (e as { name?: string })?.name;
  throw new ObscuraError(ErrorCodes.STORAGE_ERROR, `S3 ${op} failed for ${key}: ${name ?? e}`, {
    retryable: true,
    cause: e,
  });
}
const isMissing = (e: unknown) => {
  const n = (e as { name?: string; $metadata?: { httpStatusCode?: number } });
  return n?.name === 'NotFound' || n?.name === 'NoSuchKey' || n?.$metadata?.httpStatusCode === 404;
};

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly client: S3Client;
  /**
   * A separate client for signing, because the URL a browser must use is not always the
   * one the service uses. In Docker Compose the service reaches MinIO at `minio:9000`
   * while the browser needs `localhost:9000`; in a VPC the same split appears between a
   * private endpoint and a public one. Signing with the internal host produces URLs that
   * are valid but unreachable.
   */
  private readonly signingClient: S3Client;

  constructor(cfg: S3Config) {
    const base = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.signingClient = cfg.publicEndpoint && cfg.publicEndpoint !== cfg.endpoint
      ? new S3Client({ ...base, endpoint: cfg.publicEndpoint })
      : this.client;
  }

  async put(bucket: string, key: string, body: Readable | Buffer, opts: PutOptions = {}): Promise<PutResult> {
    try {
      const r = await this.client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body as never,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
        CacheControl: opts.cacheControl,
        Metadata: opts.metadata,
      }));
      return { key, etag: r.ETag ?? null };
    } catch (e) { wrap(e, 'PUT', key); }
  }

  async get(bucket: string, key: string, range?: ByteRange): Promise<GetResult> {
    try {
      const r = await this.client.send(new GetObjectCommand({
        Bucket: bucket, Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }));
      return {
        body: r.Body as Readable,
        contentLength: r.ContentLength ?? null,
        contentType: r.ContentType ?? null,
        contentRange: r.ContentRange ?? null,
        etag: r.ETag ?? null,
      };
    } catch (e) {
      if (isMissing(e)) {
        throw new ObscuraError(ErrorCodes.NOT_FOUND, `Object not found: ${key}`, { status: 404 });
      }
      wrap(e, 'GET', key);
    }
  }

  async head(bucket: string, key: string): Promise<ObjectMetadata | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key,
        size: r.ContentLength ?? 0,
        contentType: r.ContentType ?? null,
        etag: r.ETag ?? null,
        lastModified: r.LastModified ?? null,
      };
    } catch (e) {
      if (isMissing(e)) return null;
      wrap(e, 'HEAD', key);
    }
  }

  /** Batched: S3 DeleteObjects accepts 1000 keys per call. */
  async delete(bucket: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        const r = await this.client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
        }));
        if (r.Errors?.length) {
          throw new ObscuraError(
            ErrorCodes.STORAGE_ERROR,
            `Failed to delete ${r.Errors.length} object(s); first: ${r.Errors[0]?.Key} ${r.Errors[0]?.Message}`,
            { retryable: true },
          );
        }
        deleted += r.Deleted?.length ?? batch.length;
      } catch (e) {
        if (e instanceof ObscuraError) throw e;
        wrap(e, 'DELETE', batch[0] ?? '');
      }
    }
    return deleted;
  }

  async list(bucket: string, prefix: string, cursor?: string): Promise<ListPage> {
    try {
      const r = await this.client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: cursor, MaxKeys: 1000,
      }));
      return {
        objects: (r.Contents ?? []).map((o) => ({ key: o.Key!, size: o.Size ?? 0 })),
        cursor: r.IsTruncated ? (r.NextContinuationToken ?? null) : null,
      };
    } catch (e) { wrap(e, 'LIST', prefix); }
  }

  async signedUrl(
    bucket: string, key: string, op: 'GET' | 'PUT', ttlSeconds: number,
    opts: { contentType?: string } = {},
  ): Promise<string> {
    const cmd = op === 'GET'
      ? new GetObjectCommand({ Bucket: bucket, Key: key })
      : new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: opts.contentType });
    try {
      return await getSignedUrl(this.signingClient, cmd as never, { expiresIn: ttlSeconds });
    } catch (e) { wrap(e, `SIGN ${op}`, key); }
  }

  async createMultipart(bucket: string, key: string, contentType?: string): Promise<MultipartHandle> {
    try {
      const r = await this.client.send(new CreateMultipartUploadCommand({
        Bucket: bucket, Key: key, ContentType: contentType,
      }));
      return { key, uploadId: r.UploadId! };
    } catch (e) { wrap(e, 'CREATE_MULTIPART', key); }
  }

  async signPartUrl(h: MultipartHandle, bucket: string, partNumber: number, ttl: number): Promise<string> {
    const cmd = new UploadPartCommand({
      Bucket: bucket, Key: h.key, UploadId: h.uploadId, PartNumber: partNumber,
    });
    try {
      return await getSignedUrl(this.signingClient, cmd as never, { expiresIn: ttl });
    } catch (e) { wrap(e, 'SIGN_PART', h.key); }
  }

  async completeMultipart(
    h: MultipartHandle, bucket: string, parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    try {
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: h.key, UploadId: h.uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }));
    } catch (e) { wrap(e, 'COMPLETE_MULTIPART', h.key); }
  }

  async abortMultipart(h: MultipartHandle, bucket: string): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: bucket, Key: h.key, UploadId: h.uploadId,
      }));
    } catch (e) { wrap(e, 'ABORT_MULTIPART', h.key); }
  }
}
