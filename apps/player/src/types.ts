export interface PlaybackSession {
  session_id: string;
  token: string;
  manifest_url: string;
  expires_at: string;
  token_expires_at: string;
  refresh_after: number;
  watermark: {
    enabled: boolean;
    text: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'random' | 'dynamic';
    interval_seconds: number;
    opacity: number;
    font_size_vh: number;
    tiled: boolean;
  } | null;
}

export interface AssetSummary {
  asset_id: string;
  external_ref: string | null;
  title: string | null;
  status: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  content_type: string | null;
  size: number | null;
  /** One-way; safe to display. Never the source key or a URL to it. */
  source_sha256: string | null;
  asset_root: string | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string | null;
  error_code: string | null;
  retryable: boolean | null;
}
