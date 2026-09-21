import { loadConfig, type Config } from '@obscura/shared';
import {
  createDb, AssetRepository, SessionRepository, ContentKeyRepository,
  RenditionRepository, SubtitleRepository, type Db,
} from '@obscura/db';
import { S3StorageProvider, type StorageProvider } from '@obscura/storage';
import { EnvelopeKeyProvider, type KeyProvider } from '@obscura/encryption';
import { publicKeyFromSeed } from '@obscura/integrity';
import { createDeliveryStrategy, type DeliveryStrategy } from '@obscura/delivery';
import type { KeyObject } from 'node:crypto';

export interface Deps {
  cfg: Config;
  db: Db;
  storage: StorageProvider;
  keys: KeyProvider;
  delivery: DeliveryStrategy;
  tokenPublic: KeyObject;
  repos: {
    assets: AssetRepository;
    sessions: SessionRepository;
    contentKeys: ContentKeyRepository;
    renditions: RenditionRepository;
    subtitles: SubtitleRepository;
  };
  close(): Promise<void>;
}

export function createDeps(overrides: Partial<Config> = {}): Deps {
  const cfg = loadConfig(overrides);
  const db = createDb(cfg.database.url, cfg.database.poolMax);
  const storage = new S3StorageProvider(cfg.storage);
  return {
    cfg, db, storage,
    keys: new EnvelopeKeyProvider(cfg.keys.master),
    delivery: createDeliveryStrategy(cfg.playback.deliveryStrategy, {
      storage,
      presignTtlSeconds: cfg.playback.presignTtlSeconds,
      cdnBaseUrl: process.env['CDN_BASE_URL'],
    }),
    tokenPublic: publicKeyFromSeed(cfg.keys.tokenSeed),
    repos: {
      assets: new AssetRepository(db),
      sessions: new SessionRepository(db),
      contentKeys: new ContentKeyRepository(db),
      renditions: new RenditionRepository(db),
      subtitles: new SubtitleRepository(db),
    },
    close: () => db.close(),
  };
}
