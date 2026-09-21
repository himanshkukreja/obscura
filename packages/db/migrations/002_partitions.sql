-- Monthly partitions for the append-only event tables, so retention is a partition drop
-- rather than a long-running DELETE. ensurePartitions() extends this at runtime.

CREATE OR REPLACE FUNCTION obscura_ensure_partition(base text, month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  part text := base || '_' || to_char(month, 'YYYYMM');
  from_ts timestamptz := month;
  to_ts timestamptz := (month + interval '1 month');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      part, base, from_ts, to_ts
    );
  END IF;
END $$;

SELECT obscura_ensure_partition('session_events', date_trunc('month', now())::date);
SELECT obscura_ensure_partition('session_events', (date_trunc('month', now()) + interval '1 month')::date);
SELECT obscura_ensure_partition('audit_log', date_trunc('month', now())::date);
SELECT obscura_ensure_partition('audit_log', (date_trunc('month', now()) + interval '1 month')::date);
