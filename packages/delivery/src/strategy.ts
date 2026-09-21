import type { StorageProvider } from '@obscura/storage';

export interface SegmentRef {
  assetId: string;
  rendition: string;
  /** Stored relative URI, e.g. "seg_00001.m4s" or "init.mp4". */
  filename: string;
  storageKey: string;
}

export interface DeliveryContext {
  sessionId: string;
  token: string;
  edgePublicUrl: string;
  bucket: string;
}

/**
 * How a segment URI in a session-scoped manifest is produced.
 *
 * This is the only component that knows which delivery mode is active. Everything else -
 * packaging, hashing, storage layout - is identical across modes, which is what keeps the
 * stored artifacts free of per-session data.
 */
export interface DeliveryStrategy {
  readonly name: string;
  /** True when media bytes flow through our own service rather than storage/CDN. */
  readonly proxiesBytes: boolean;
  segmentUrl(ref: SegmentRef, ctx: DeliveryContext): Promise<string>;
}

/**
 * Bytes stream through the edge service, with Range support.
 *
 * Strongest and simplest: every byte is authorized at request time and revocation is
 * instant. It is also the expensive option - all video egress traverses the application -
 * so it is the default for local development and small self-hosted installs, never the
 * recommendation at scale.
 */
export class ProxyDeliveryStrategy implements DeliveryStrategy {
  readonly name = 'proxy';
  readonly proxiesBytes = true;

  async segmentUrl(ref: SegmentRef, ctx: DeliveryContext): Promise<string> {
    const p = `${ctx.edgePublicUrl}/stream/${ctx.sessionId}/seg/${encodeURIComponent(ref.rendition)}/${encodeURIComponent(ref.filename)}`;
    return `${p}?t=${encodeURIComponent(ctx.token)}`;
  }
}

/**
 * Short-lived presigned GETs straight to object storage. No CDN configuration required.
 *
 * Caveat that cannot be abstracted away: Cloudflare R2 presigned URLs are not served
 * through the CDN cache and bypass custom domains, so on Cloudflare this mode means no
 * caching. That is a DeliveryStrategy concern, not a StorageProvider one.
 */
export class PresignedDeliveryStrategy implements DeliveryStrategy {
  readonly name = 'presigned';
  readonly proxiesBytes = false;

  constructor(
    private readonly storage: StorageProvider,
    private readonly ttlSeconds: number,
  ) {}

  async segmentUrl(ref: SegmentRef, ctx: DeliveryContext): Promise<string> {
    return this.storage.signedUrl(ctx.bucket, ref.storageKey, 'GET', this.ttlSeconds);
  }
}

/**
 * Stable segment URLs plus a token the CDN edge validates and strips from the cache key.
 *
 * The recommended production configuration, and effectively mandatory on Cloudflare. The
 * edge function is deployed per CDN; see examples/. Until one is deployed this behaves
 * like `proxy` against the configured public URL, so a misconfiguration degrades to
 * "works but costs bandwidth" rather than "serves unauthorized bytes".
 */
export class CdnSignedDeliveryStrategy implements DeliveryStrategy {
  readonly name = 'cdn_signed';
  readonly proxiesBytes = false;

  constructor(private readonly cdnBaseUrl: string) {}

  async segmentUrl(ref: SegmentRef, ctx: DeliveryContext): Promise<string> {
    const base = this.cdnBaseUrl.replace(/\/+$/, '');
    return `${base}/${ref.storageKey}?t=${encodeURIComponent(ctx.token)}`;
  }
}

export function createDeliveryStrategy(
  name: string,
  deps: { storage: StorageProvider; presignTtlSeconds: number; cdnBaseUrl?: string },
): DeliveryStrategy {
  switch (name) {
    case 'presigned': return new PresignedDeliveryStrategy(deps.storage, deps.presignTtlSeconds);
    case 'cdn_signed':
      if (!deps.cdnBaseUrl) throw new Error('DELIVERY_STRATEGY=cdn_signed requires CDN_BASE_URL');
      return new CdnSignedDeliveryStrategy(deps.cdnBaseUrl);
    case 'proxy': return new ProxyDeliveryStrategy();
    default: throw new Error(`Unknown delivery strategy: ${name}`);
  }
}
