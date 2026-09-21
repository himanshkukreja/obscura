-- One content key per asset, enforced by the database rather than by convention.
--
-- Rendition jobs run concurrently. When key creation was lazy, two of them could each
-- observe "no key yet" and mint one, encrypting different rungs under different keys while
-- the manifest advertised a single kid. The application now creates the key once in the
-- process job; this constraint makes the old failure mode unrepresentable.
DELETE FROM content_keys a USING content_keys b
  WHERE a.asset_id = b.asset_id AND a.rotation_index = b.rotation_index AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS content_keys_one_per_asset
  ON content_keys (asset_id, rotation_index);
