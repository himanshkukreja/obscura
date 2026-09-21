import { createHash } from 'node:crypto';
import type { LadderConfig, PackagingConfig, WatermarkPolicy } from './types.ts';

/** Development-only placeholders. The API refuses to start with these in production. */
const DEV_MASTER_KEY = 'ZGV2LW9ubHktbWFzdGVyLWtleS1ETy1OT1QtVVNFISE=';
const DEV_TOKEN_SEED = 'ZGV2LW9ubHktdG9rZW4tc2VlZC1ETy1OT1QtVVNFISE=';
const DEV_INTEGRITY_SEED = 'ZGV2LW9ubHktaW50ZWctc2VlZC1ETy1OT1QtVVNFISE=';
const DEV_HASH_SALT = 'ZGV2LW9ubHktaXAtaGFzaC1zYWx0';

export const DEV_PLACEHOLDERS = new Set([
  DEV_MASTER_KEY, DEV_TOKEN_SEED, DEV_INTEGRITY_SEED, DEV_HASH_SALT,
]);

export interface Config {
  env: 'development' | 'production' | 'test';
  pipelineVersion: string;

  api: { host: string; port: number };
  edge: { host: string; port: number; publicUrl: string };

  database: { url: string; poolMax: number };
  redis: { url: string };

  storage: {
    endpoint: string | undefined;
    /**
     * Endpoint used when SIGNING urls handed to a browser. Differs from `endpoint`
     * whenever the service reaches storage over a private path the client cannot use -
     * a Docker network, a VPC endpoint, an internal load balancer.
     */
    publicEndpoint: string | undefined;
    region: string;
    /**
     * Undefined means "no static credentials": the AWS SDK falls back to its default
     * provider chain, which is how an EC2 instance role reaches storage with no
     * long-lived secret anywhere on the box.
     */
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    forcePathStyle: boolean;
    sourceBucket: string;
    deliveryBucket: string;
  };

  keys: {
    /** 32 raw bytes, base64. Wraps every content key. */
    master: Buffer;
    /** 32-byte Ed25519 seed for playback tokens. */
    tokenSeed: Buffer;
    /** 32-byte Ed25519 seed for integrity + deletion signatures. */
    integritySeed: Buffer;
    integrityKeyId: string;
  };

  playback: {
    sessionTtlSeconds: number;
    tokenTtlSeconds: number;
    heartbeatIntervalSeconds: number;
    maxConcurrentSessionsPerSubject: number | null;
    deliveryStrategy: 'proxy' | 'presigned' | 'cdn_signed';
    presignTtlSeconds: number;
    corsOrigins: string[];
  };

  privacy: {
    storeIp: 'none' | 'hashed' | 'raw';
    storeUserAgent: 'none' | 'hashed' | 'raw';
    hashSalt: Buffer;
    storeOriginalFilename: boolean;
  };

  retention: {
    playbackSessionsDays: number;
    sessionEventsDays: number;
    auditLogDays: number;
    failedJobsDays: number;
  };

  ladder: LadderConfig;
  packaging: PackagingConfig;
  watermark: WatermarkPolicy;

  media: { ffmpegPath: string; ffprobePath: string; workDir: string; maxDurationSec: number };
  worker: { concurrency: number };
  uploads: { maxBytes: number; urlTtlSeconds: number };
}

function env(k: string, d?: string): string {
  const v = process.env[k];
  if (v === undefined || v === '') {
    if (d === undefined) throw new Error(`Missing required environment variable ${k}`);
    return d;
  }
  return v;
}
const num = (k: string, d: number) => {
  const v = process.env[k];
  if (!v) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
  return n;
};
const bool = (k: string, d: boolean) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v === 'true' || v === '1';
};
/**
 * Credentials are three-state, unlike everything else here.
 *
 *   unset        -> the development default, so a bare `docker compose up` works
 *   set to ''    -> explicitly NO static credentials: defer to the AWS SDK's provider
 *                   chain (environment, shared config, then the EC2 instance role)
 *   set to value -> use it
 *
 * The middle case is what DEPLOY.md asks operators to write, and collapsing it into the
 * default silently shipped MinIO's dev key to real S3.
 */
const optionalCredential = (k: string, d: string): string | undefined => {
  const v = process.env[k];
  if (v === undefined) return d;
  return v === '' ? undefined : v;
};
const key32 = (k: string, d: string): Buffer => {
  const b = Buffer.from(env(k, d), 'base64');
  if (b.length !== 32) throw new Error(`${k} must decode to exactly 32 bytes (got ${b.length})`);
  return b;
};

export const DEFAULT_LADDER: LadderConfig = {
  allowUpscaling: false,
  maxBitrateRatio: 1.1,
  minRenditions: 1,
  /**
   * Constant across rungs, deliberately. For conversational video the audio IS the
   * content: a viewer on a poor connection needs to keep hearing the words even as the
   * picture degrades. A ladder that drops audio to 64k at the bottom optimises the wrong
   * axis.
   */
  audioBitrate: '128k',
  /**
   * The 1080p rung is included even though the primary use case is webcam footage, which
   * rarely has real 1080p detail. Leaving it out was a mistake: `selectLadder` already
   * drops every rung taller than the source, so a 720p webcam upload never produces a
   * 1080p rendition regardless. Omitting it from the config only hurt genuinely HD
   * sources, which got silently capped at 720p.
   *
   * Bitrates are sized for the low-motion, face-and-voice profile. Detailed or
   * high-motion content wants higher; screen capture and coding exercises want a
   * different profile entirely (static, text-heavy, legibility over fidelity).
   */
  renditions: [
    { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k' },
    { name: '720p', width: 1280, height: 720, videoBitrate: '2800k' },
    { name: '480p', width: 854, height: 480, videoBitrate: '1400k' },
    { name: '360p', width: 640, height: 360, videoBitrate: '800k' },
  ],
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = (process.env['NODE_ENV'] ?? 'development') as Config['env'];

  const master = key32('OBSCURA_MASTER_KEY', DEV_MASTER_KEY);
  const tokenSeed = key32('OBSCURA_TOKEN_SEED', DEV_TOKEN_SEED);
  const integritySeed = key32('OBSCURA_INTEGRITY_SEED', DEV_INTEGRITY_SEED);

  if (nodeEnv === 'production') {
    for (const [name, raw] of [
      ['OBSCURA_MASTER_KEY', process.env['OBSCURA_MASTER_KEY']],
      ['OBSCURA_TOKEN_SEED', process.env['OBSCURA_TOKEN_SEED']],
      ['OBSCURA_INTEGRITY_SEED', process.env['OBSCURA_INTEGRITY_SEED']],
      ['OBSCURA_HASH_SALT', process.env['OBSCURA_HASH_SALT']],
    ] as const) {
      if (!raw) throw new Error(`${name} must be set explicitly in production`);
      if (DEV_PLACEHOLDERS.has(raw)) {
        throw new Error(`${name} is still the development placeholder. Refusing to start.`);
      }
    }
  }

  const cfg: Config = {
    env: nodeEnv,
    pipelineVersion: env('OBSCURA_PIPELINE_VERSION', '1.0.0'),

    api: { host: env('API_HOST', '0.0.0.0'), port: num('API_PORT', 3001) },
    edge: {
      host: env('EDGE_HOST', '0.0.0.0'),
      port: num('EDGE_PORT', 3002),
      publicUrl: env('EDGE_PUBLIC_URL', 'http://localhost:3002').replace(/\/+$/, ''),
    },

    database: {
      url: env('DATABASE_URL', 'postgres://obscura:obscura@localhost:5432/obscura'),
      poolMax: num('DATABASE_POOL_MAX', 10),
    },
    redis: { url: env('REDIS_URL', 'redis://localhost:6379') },

    storage: {
      endpoint: process.env['S3_ENDPOINT'] || undefined,
      publicEndpoint: process.env['S3_PUBLIC_ENDPOINT'] || process.env['S3_ENDPOINT'] || undefined,
      region: env('S3_REGION', 'us-east-1'),
      accessKeyId: optionalCredential('S3_ACCESS_KEY_ID', 'obscura'),
      secretAccessKey: optionalCredential('S3_SECRET_ACCESS_KEY', 'obscura123'),
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
      sourceBucket: env('S3_SOURCE_BUCKET', 'obscura-source'),
      deliveryBucket: env('S3_DELIVERY_BUCKET', 'obscura-delivery'),
    },

    keys: {
      master,
      tokenSeed,
      integritySeed,
      integrityKeyId: env('OBSCURA_INTEGRITY_KEY_ID', 'obscura-integrity-dev'),
    },

    playback: {
      sessionTtlSeconds: num('PLAYBACK_SESSION_TTL', 4 * 3600),
      tokenTtlSeconds: num('PLAYBACK_TOKEN_TTL', 180),
      heartbeatIntervalSeconds: num('PLAYBACK_HEARTBEAT_INTERVAL', 60),
      maxConcurrentSessionsPerSubject:
        process.env['PLAYBACK_MAX_CONCURRENT'] ? num('PLAYBACK_MAX_CONCURRENT', 0) : null,
      deliveryStrategy: env('DELIVERY_STRATEGY', 'proxy') as Config['playback']['deliveryStrategy'],
      presignTtlSeconds: num('DELIVERY_PRESIGN_TTL', 600),
      corsOrigins: env('CORS_ORIGINS', 'http://localhost:3000').split(',').map((s) => s.trim()),
    },

    privacy: {
      storeIp: env('PRIVACY_STORE_IP', 'hashed') as Config['privacy']['storeIp'],
      storeUserAgent: env('PRIVACY_STORE_USER_AGENT', 'hashed') as Config['privacy']['storeUserAgent'],
      hashSalt: Buffer.from(env('OBSCURA_HASH_SALT', DEV_HASH_SALT), 'base64'),
      storeOriginalFilename: bool('PRIVACY_STORE_ORIGINAL_FILENAME', true),
    },

    retention: {
      playbackSessionsDays: num('RETENTION_SESSIONS_DAYS', 90),
      sessionEventsDays: num('RETENTION_EVENTS_DAYS', 30),
      auditLogDays: num('RETENTION_AUDIT_DAYS', 365),
      failedJobsDays: num('RETENTION_FAILED_JOBS_DAYS', 30),
    },

    ladder: DEFAULT_LADDER,
    packaging: {
      segmentDurationSec: num('PACKAGING_SEGMENT_DURATION', 4),
      container: env('PACKAGING_CONTAINER', 'fmp4') as 'fmp4' | 'mpegts',
      independentSegments: true,
    },
    watermark: {
      enabled: bool('WATERMARK_ENABLED', true),
      textTemplate: env('WATERMARK_TEMPLATE', '{{user.label}} · {{asset.short_id}}'),
      opacity: num('WATERMARK_OPACITY', 0.35),
      fontSizeVh: num('WATERMARK_FONT_SIZE_VH', 2),
      position: env('WATERMARK_POSITION', 'dynamic') as WatermarkPolicy['position'],
      intervalSeconds: num('WATERMARK_INTERVAL', 15),
      tiled: bool('WATERMARK_TILED', false),
    },

    media: {
      ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
      ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
      workDir: env('MEDIA_WORK_DIR', '/tmp/obscura'),
      maxDurationSec: num('MEDIA_MAX_DURATION', 6 * 3600),
    },
    worker: { concurrency: num('WORKER_CONCURRENCY', 2) },
    uploads: {
      maxBytes: num('UPLOAD_MAX_BYTES', 20 * 1024 ** 3),
      urlTtlSeconds: num('UPLOAD_URL_TTL', 900),
    },
  };

  return { ...cfg, ...overrides };
}

export function ladderConfigHash(l: LadderConfig): string {
  return createHash('sha256').update(JSON.stringify(l)).digest('hex');
}
