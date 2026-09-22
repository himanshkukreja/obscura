-- Per-tenant brand watermark, burned into every rendition at transcode.
--
-- Deliberately NOT what ADR-0012 rejected. That decision turned on per-VIEWER burn-in
-- scattering copies of personal data across storage: N viewers meant N derivatives, each
-- one more thing to find and destroy on an erasure request. A tenant logo is identical for
-- every viewer of that tenant, so this still produces exactly one rendition set per asset.
-- The deletion surface does not grow.

-- What was actually burned into THIS asset, captured at ingest. Branding can change
-- afterwards; the asset keeps whatever it was made with, and the integrity manifest can
-- attest to it. Without this, "which logo is on this recording" is unanswerable after a
-- tenant rebrands.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS branding jsonb;

COMMENT ON COLUMN assets.branding IS
  'Brand watermark applied at transcode: {logo_sha256, position, opacity, height_pct}. '
  'Null means none was applied. Records what WAS done, not what is currently configured.';
