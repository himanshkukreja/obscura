import { loadConfig, type Config } from '@obscura/shared';
import { createDb, AssetRepository, SessionRepository, ContentKeyRepository,
  RenditionRepository, SubtitleRepository, JobRepository, DeletionRepository,
  AuditRepository, type Db } from '@obscura/db';
import { S3StorageProvider, type StorageProvider } from '@obscura/storage';
import { EnvelopeKeyProvider, type KeyProvider } from '@obscura/encryption';
import { privateKeyFromSeed, publicKeyFromSeed } from '@obscura/integrity';
import type { KeyObject } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { PINO_REDACT_PATHS } from '@obscura/shared';

export interface Ctx {
  cfg: Config;
  db: Db;
  log: Logger;
  storage: StorageProvider;
  keys: KeyProvider;
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
  };
}

export function createContext(overrides: Partial<Config> = {}): Ctx {
  const cfg = loadConfig(overrides);
  const db = createDb(cfg.database.url, cfg.database.poolMax);
  const log = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
  });
  return {
    cfg, db, log,
    storage: new S3StorageProvider(cfg.storage),
    keys: new EnvelopeKeyProvider(cfg.keys.master),
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
    },
  };
}
