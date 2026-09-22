// ── Asset lifecycle ─────────────────────────────────────────────────────────

export const AssetStatus = {
  UPLOADING: 'UPLOADING',
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  PROCESSING: 'PROCESSING',
  PACKAGING: 'PACKAGING',
  ENCRYPTING: 'ENCRYPTING',
  READY: 'READY',
  FAILED: 'FAILED',
  DELETING: 'DELETING',
  DELETED: 'DELETED',
} as const;
export type AssetStatus = (typeof AssetStatus)[keyof typeof AssetStatus];

export const TERMINAL_STATUSES: AssetStatus[] = [
  AssetStatus.READY,
  AssetStatus.FAILED,
  AssetStatus.DELETED,
];

// ── Probe ───────────────────────────────────────────────────────────────────

export interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  videoCodec: string;
  audioCodec: string | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  pixelFormat: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  rotation: number;
  /** Display dimensions after rotation is applied. */
  displayWidth: number;
  displayHeight: number;
  isHdr: boolean;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName: string;
  sizeBytes: number | null;
  raw: unknown;
}

// ── Ladder ──────────────────────────────────────────────────────────────────

export interface RenditionSpec {
  name: string;
  width: number;
  height: number;
  /**
   * Bitrate CEILING, not a target. The encoder is quality-targeted (see `crf`), so this
   * caps peak bitrate for ABR switching rather than dictating how many bits every second
   * of video gets. It is also what the master playlist advertises as BANDWIDTH.
   */
  videoBitrate: string;
  /**
   * Constant Rate Factor: the quality the encoder aims for, spending only the bits that
   * quality needs. Lower is better quality and larger. 18 is near-transparent, 23 is the
   * usual VOD default, 28 is visibly soft.
   *
   * This exists because targeting a bitrate instead wastes most of it on the footage this
   * is built for. Measured on a real 720p interview: capped CBR at 2800k produced 2956
   * kbps at SSIM 0.9950, while CRF 23 produced 1010 kbps at SSIM 0.9879 - a third of the
   * bytes for a difference no viewer can see on a talking head. High-motion content is
   * the case that genuinely needs the bits, and it still gets them, because CRF spends
   * more where the picture is harder.
   */
  crf?: number;
}

export interface LadderConfig {
  allowUpscaling: boolean;
  maxBitrateRatio: number;
  minRenditions: number;
  /** Applied to any rendition that does not set its own. */
  defaultCrf?: number;
  /** Constant across rungs: for conversational video the audio IS the content. */
  audioBitrate: string;
  renditions: RenditionSpec[];
}

/** A rung after selection, with concrete even dimensions for this source. */
export interface ResolvedRendition {
  name: string;
  width: number;
  height: number;
  /** Peak ceiling, advertised as BANDWIDTH. See RenditionSpec.videoBitrate. */
  videoBitrate: string;
  audioBitrate: string;
  /** Quality target. Absent means fall back to fixed-bitrate encoding. */
  crf?: number;
}

// ── Brand watermark ─────────────────────────────────────────────────────────

/**
 * A tenant's logo, burned into every rendition at transcode.
 *
 * This is NOT the per-viewer watermark and must not be confused with it. That one
 * identifies WHO IS WATCHING, varies per session, and stays a client-side overlay because
 * ADR-0012 established that per-viewer derivatives multiply copies of personal data.
 *
 * A brand mark is identical for every viewer of a tenant, so burning it in still yields
 * one rendition set per asset — the deletion surface does not grow, and the ADR's
 * objection does not apply. In exchange it survives a screen recording and cannot be
 * removed from devtools, which is the only thing that makes a brand mark worth having.
 */
export interface BrandingPolicy {
  /** Storage key of the logo, in the delivery bucket. */
  logoKey: string;
  /** Hash of the logo bytes, so an asset can attest which mark it carries. */
  logoSha256: string;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** 0..1. Applied to the logo's own alpha, so a transparent PNG stays transparent. */
  opacity: number;
  /** Logo height as a percentage of video height, so it scales across the ladder. */
  heightPct: number;
}

/** What was actually burned into one asset. Recorded at ingest, never rewritten. */
export interface AppliedBranding {
  logoSha256: string;
  position: BrandingPolicy['position'];
  opacity: number;
  heightPct: number;
}

// ── Packaging ───────────────────────────────────────────────────────────────

export interface PackagingConfig {
  segmentDurationSec: number;
  container: 'fmp4' | 'mpegts';
  independentSegments: boolean;
}

// ── Integrity ───────────────────────────────────────────────────────────────

export interface SegmentHash {
  index: number;
  sha256: string;
  size: number;
}

export interface RenditionIntegrity {
  name: string;
  width: number;
  height: number;
  encryption: { method: 'AES-128' | 'NONE'; kid: string | null };
  playlistSha256: string;
  initSha256: string | null;
  segmentCount: number;
  merkleRoot: string;
  segments: SegmentHash[];
}

export interface IntegrityManifest {
  schema: 'obscura.integrity/v1';
  assetId: string;
  createdAt: string;
  pipeline: {
    version: string;
    ffmpeg: string;
    ladderConfigSha256: string;
    packaging: PackagingConfig;
    /** Present when a tenant brand mark was burned into these renditions. */
    branding?: AppliedBranding;
  };
  source: {
    sha256: string;
    size: number;
    contentType: string | null;
    originalFilename: string | null;
    probeSha256: string;
  };
  renditions: RenditionIntegrity[];
  subtitles: { language: string; playlistSha256: string; merkleRoot: string }[];
  assetRoot: string;
  signature?: {
    algorithm: 'Ed25519';
    keyId: string;
    canonicalization: 'RFC8785';
    value: string;
  };
}

export interface MerkleProof {
  leafIndex: number;
  leafHash: string;
  path: { hash: string; side: 'left' | 'right' }[];
  root: string;
}

// ── Deletion ────────────────────────────────────────────────────────────────

export type DeletionReason =
  | 'data_subject_request'
  | 'retention'
  | 'operator'
  | 'client_request';

export interface DeletionRecord {
  schema: 'obscura.deletion/v1';
  assetId: string;
  sourceSha256: string | null;
  assetRoot: string | null;
  reason: DeletionReason;
  requestedBy: string | null;
  requestedAt: string;
  completedAt: string | null;
  objectsDeleted: number;
  storageVerifiedEmpty: boolean;
  contentKeysDestroyed: number;
  cdnInvalidation: { requested: boolean; provider: string | null; id: string | null } | null;
  sessionsRevoked: number;
  signature?: {
    algorithm: 'Ed25519';
    keyId: string;
    canonicalization: 'RFC8785';
    value: string;
  };
}

// ── Playback ────────────────────────────────────────────────────────────────

export interface WatermarkPolicy {
  enabled: boolean;
  textTemplate: string;
  opacity: number;
  fontSizeVh: number;
  position:
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    | 'center' | 'random' | 'dynamic';
  intervalSeconds: number;
  tiled: boolean;
}

export interface PlaybackSessionResponse {
  sessionId: string;
  token: string;
  manifestUrl: string;
  expiresAt: string;
  tokenExpiresAt: string;
  refreshAfter: number;
  watermark: {
    enabled: boolean;
    text: string;
    position: WatermarkPolicy['position'];
    intervalSeconds: number;
    opacity: number;
    fontSizeVh: number;
    tiled: boolean;
  } | null;
}

export type TokenScope = 'manifest' | 'key' | 'segment' | 'all';

export interface PlaybackTokenClaims {
  /** session id, base64url */
  sid: string;
  /** asset id */
  aid: string;
  scope: TokenScope;
  /** epoch seconds */
  exp: number;
  iat: number;
  /** token id, for replay tracking */
  jti: string;
  /** session token epoch - bumping it invalidates every issued token */
  ep: number;
}

// ── Delivery ────────────────────────────────────────────────────────────────

export type DeliveryStrategyName = 'proxy' | 'presigned' | 'cdn_signed';

// ── Job queue contract ──────────────────────────────────────────────────────
// Lives in shared so the API can enqueue and the worker can consume without either
// depending on the other.

export const QUEUE_NAME = 'obscura';

/**
 * BullMQ rejects ':' in a custom job id (it is its own key separator). Our idempotency
 * keys use ':' because they are readable in the database, so translate at the boundary
 * rather than degrading the stored key.
 */
export function queueJobId(idempotencyKey: string): string {
  return idempotencyKey.replace(/:/g, '__');
}

export type JobPayload =
  | { type: 'process'; assetId: string }
  | { type: 'rendition'; assetId: string; rendition: string; jobId: string }
  | { type: 'finalize'; assetId: string }
  | {
      type: 'subtitles'; assetId: string; trackId: string; language: string;
      label: string | null; isDefault: boolean; origin: string; vtt: string;
    }
  | { type: 'delete'; assetId: string; reason: string; requestedBy: string | null }
  | { type: 'retention' };
