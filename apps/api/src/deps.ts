import { loadConfig, type Config } from '@obscura/shared';
import {
  createDb, AssetRepository, SessionRepository, ContentKeyRepository, RenditionRepository,
  SubtitleRepository, JobRepository, DeletionRepository, AuditRepository, ApiClientRepository,
  type Db,
} from '@obscura/db';
import { S3StorageProvider, type StorageProvider } from '@obscura/storage';
import { EnvelopeKeyProvider, type KeyProvider } from '@obscura/encryption';
import { privateKeyFromSeed, publicKeyFromSeed } from '@obscura/integrity';
import { createDeliveryStrategy, type DeliveryStrategy } from '@obscura/delivery';
import { createQueue, type JobPayload } from './queue.ts';
import type { Queue } from 'bullmq';
import type { KeyObject } from 'node:crypto';

export { authenticate } from '@obscura/auth';
export type { ApiClientRow } from '@obscura/db';

export interface Deps {
  cfg: Config;
  db: Db;
  storage: StorageProvider;
  keys: KeyProvider;
  delivery: DeliveryStrategy;
  queue: Queue<JobPayload>;
  tokenPrivate: KeyObject;
  tokenPublic: KeyObject;
  integrityPrivate: KeyObject;
  integrityPublic: KeyObject;
  repos: {
    assets: AssetRepository;
    sessions: SessionRepository;
    contentKeys: ContentKeyRepository;
    renditions: RenditionRepository;
    subtitles: SubtitleRepository;
    jobs: JobRepository;
    deletions: DeletionRepository;
    audit: AuditRepository;
    clients: ApiClientRepository;
  };
  close(): Promise<void>;
}

export function createDeps(overrides: Partial<Config> = {}): Deps {
  const cfg = loadConfig(overrides);
  const db = createDb(cfg.database.url, cfg.database.poolMax);
  const storage = new S3StorageProvider(cfg.storage);
  const queue = createQueue(cfg.redis.url);

  return {
    cfg, db, storage, queue,
    keys: new EnvelopeKeyProvider(cfg.keys.master),
    delivery: createDeliveryStrategy(cfg.playback.deliveryStrategy, {
      storage,
      presignTtlSeconds: cfg.playback.presignTtlSeconds,
      cdnBaseUrl: process.env['CDN_BASE_URL'],
    }),
    tokenPrivate: privateKeyFromSeed(cfg.keys.tokenSeed),
    tokenPublic: publicKeyFromSeed(cfg.keys.tokenSeed),
    integrityPrivate: privateKeyFromSeed(cfg.keys.integritySeed),
    integrityPublic: publicKeyFromSeed(cfg.keys.integritySeed),
    repos: {
      assets: new AssetRepository(db),
      sessions: new SessionRepository(db),
      contentKeys: new ContentKeyRepository(db),
      renditions: new RenditionRepository(db),
      subtitles: new SubtitleRepository(db),
      jobs: new JobRepository(db),
      deletions: new DeletionRepository(db),
      audit: new AuditRepository(db),
      clients: new ApiClientRepository(db),
    },
    async close() {
      await queue.close();
      await db.close();
    },
  };
}
