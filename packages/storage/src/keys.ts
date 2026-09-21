/**
 * Canonical storage layout. Every key in the system is produced here so that the deletion
 * job's prefix enumeration cannot drift from what the pipeline writes.
 */
export const StorageKeys = {
  assetPrefix: (assetId: string) => `videos/${assetId}/`,
  sourcePrefix: (assetId: string) => `videos/${assetId}/source/`,
  source: (assetId: string, ext: string) => `videos/${assetId}/source/original${ext}`,

  hlsPrefix: (assetId: string) => `videos/${assetId}/hls/`,
  master: (assetId: string) => `videos/${assetId}/hls/master.m3u8`,
  renditionPrefix: (assetId: string, r: string) => `videos/${assetId}/hls/${r}/`,
  playlist: (assetId: string, r: string) => `videos/${assetId}/hls/${r}/playlist.m3u8`,
  init: (assetId: string, r: string) => `videos/${assetId}/hls/${r}/init.mp4`,
  segment: (assetId: string, r: string, i: number, ext = 'm4s') =>
    `videos/${assetId}/hls/${r}/seg_${String(i).padStart(5, '0')}.${ext}`,

  subsPrefix: (assetId: string) => `videos/${assetId}/hls/subs/`,
  subPlaylist: (assetId: string, lang: string) => `videos/${assetId}/hls/subs/${lang}/playlist.m3u8`,
  subSegment: (assetId: string, lang: string, i: number) =>
    `videos/${assetId}/hls/subs/${lang}/seg_${String(i).padStart(5, '0')}.vtt`,

  metadataPrefix: (assetId: string) => `videos/${assetId}/metadata/`,
  /** Segment hashes recorded by the rendition job, so finalize need not re-read the media. */
  segmentHashes: (assetId: string, r: string) => `videos/${assetId}/metadata/segments-${r}.json`,
  assetJson: (assetId: string) => `videos/${assetId}/metadata/asset.json`,
  integrityJson: (assetId: string) => `videos/${assetId}/metadata/integrity.json`,
} as const;

/** Every prefix the delete job must enumerate, per bucket role. */
export const DELETION_PREFIXES = {
  source: (assetId: string) => [StorageKeys.sourcePrefix(assetId)],
  delivery: (assetId: string) => [
    StorageKeys.hlsPrefix(assetId),
    StorageKeys.metadataPrefix(assetId),
  ],
} as const;

const SEG_RE = /seg_(\d{5})\.(m4s|ts)$/;
export function segmentIndexFromKey(key: string): number | null {
  const m = SEG_RE.exec(key);
  return m ? Number(m[1]) : null;
}
