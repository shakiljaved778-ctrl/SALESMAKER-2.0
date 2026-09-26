-- 0008_outbox — P01 T07: transactional outbox (§3.7, §3.9). Additive (expand-only).
-- Partitioned by day on created_at, so retention is a DROP of old partitions, never a DELETE.

-- CreateTable
CREATE TABLE "outbox_event" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGSERIAL NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregate_type" TEXT,
    "aggregate_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("tenant_id","created_at","id")
) PARTITION BY RANGE ("created_at");

-- CreateIndex
CREATE INDEX "outbox_event_tenant_id_published_at_created_at_idx" ON "outbox_event"("tenant_id", "published_at", "created_at");

-- `<queue>.<event>`: the prefix names the BullMQ queue (lower-case snake case).
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_topic"
  CHECK ("topic" ~ '^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.]*$');

-- ── Wake the relay ─────────────────────────────────────────────────────────────────────────
-- NOTIFY is delivered on commit and de-duplicated per transaction, so a transaction that emits
-- many events wakes the relay once per tenant. The payload is only the tenant id: the relay
-- then reads that tenant's events inside a normal tenant transaction (RLS applies).
CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sm_outbox', NEW.tenant_id::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER outbox_notify AFTER INSERT ON "outbox_event"
  FOR EACH ROW EXECUTE FUNCTION outbox_notify();

-- ── Partitions ─────────────────────────────────────────────────────────────────────────────
-- Creates daily partitions (UTC) from yesterday to p_days_ahead days out, each with forced RLS
-- and the tenant_isolation policy (the RLS audit checks partitions too), and drops partitions
-- older than p_retention_days. Runs as the schema owner so the runtime role can call it from the
-- worker's maintenance job without holding DDL rights. It never reads rows.
CREATE OR REPLACE FUNCTION outbox_maintain_partitions(p_days_ahead int DEFAULT 7, p_retention_days int DEFAULT 7)
RETURNS TABLE (created text[], dropped text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  part text;
  made text[] := '{}';
  gone text[] := '{}';
BEGIN
  IF p_days_ahead NOT BETWEEN 1 AND 60 OR p_retention_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'outbox_maintain_partitions: days ahead must be 1-60 and retention 1-90';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('outbox_event:partitions', 0));
  FOR d IN SELECT generate_series(today - 1, today + p_days_ahead, interval '1 day')::date LOOP
    part := 'outbox_event_p' || to_char(d, 'YYYYMMDD');
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF outbox_event FOR VALUES FROM (%L) TO (%L)',
        part, (d::timestamp AT TIME ZONE 'UTC'), ((d + 1)::timestamp AT TIME ZONE 'UTC'));
      PERFORM enable_tenant_rls(format('public.%I', part)::regclass);
      made := made || part;
    END IF;
  END LOOP;
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'outbox_event'::regclass AND c.relname ~ '^outbox_event_p[0-9]{8}$'
      AND to_date(substr(c.relname, 15), 'YYYYMMDD') < today - p_retention_days
    ORDER BY 1
  LOOP
    EXECUTE format('DROP TABLE public.%I', part);
    gone := gone || part;
  END LOOP;
  RETURN QUERY SELECT made, gone;
END
$$;
REVOKE ALL ON FUNCTION outbox_maintain_partitions(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_maintain_partitions(int, int) TO sm_app;

-- ── Row-level security (parent now; each partition as it is created) ───────────────────────
SELECT enable_tenant_rls('outbox_event');
SELECT outbox_maintain_partitions();
