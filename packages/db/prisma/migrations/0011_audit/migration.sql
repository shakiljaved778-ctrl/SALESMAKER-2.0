-- 0011_audit — P01 T11: the hash-chained audit log, its batches and verifications, and the setup
-- audit trail (§4.2, §6.7, ADR-0008 and its addendum). Additive (expand-only).

-- ── Per-tenant sequence ───────────────────────────────────────────────────────────────────
-- Each tenant has its own sequence, so audited transactions never wait on each other (no lock,
-- no hot row): a rolled-back transaction just leaves a gap, which the chain job declares. It is
-- created on first use; SECURITY DEFINER because only the schema owner may create sequences.
CREATE OR REPLACE FUNCTION audit_next_seq() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  t uuid := app_current_tenant_id();
  seq_name text;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'audit_next_seq needs a tenant transaction';
  END IF;
  seq_name := 'audit_seq_' || replace(t::text, '-', '');
  IF to_regclass(format('public.%I', seq_name)) IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('audit_seq:' || t::text, 0));
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I AS bigint MINVALUE 1', seq_name);
  END IF;
  RETURN nextval(format('public.%I', seq_name)::regclass);
END
$$;
REVOKE ALL ON FUNCTION audit_next_seq() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_next_seq() TO sm_app;

-- CreateEnum
CREATE TYPE "audit_verification_status" AS ENUM ('OK', 'BROKEN');

-- CreateTable
CREATE TABLE "audit_log" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inserted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "seq" BIGINT NOT NULL DEFAULT audit_next_seq(),
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "on_behalf_of" UUID,
    "action" TEXT NOT NULL,
    "object" TEXT,
    "record_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT,
    "chained_at" TIMESTAMPTZ(6),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("tenant_id","occurred_at","id")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "audit_batch" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "first_seq" BIGINT NOT NULL,
    "last_seq" BIGINT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "gaps" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "head_hash" TEXT NOT NULL,
    "merkle_root" TEXT NOT NULL,
    "prev_root" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_batch_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "audit_verification" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "audit_verification_status" NOT NULL,
    "through_seq" BIGINT,
    "batches" INTEGER NOT NULL,
    "rows" INTEGER NOT NULL,
    "pending" INTEGER NOT NULL,
    "problem" TEXT,

    CONSTRAINT "audit_verification_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "setup_audit" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "entity_name" TEXT,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,

    CONSTRAINT "setup_audit_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_seq_idx" ON "audit_log"("tenant_id", "seq");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_object_record_id_occurred_at_idx" ON "audit_log"("tenant_id", "object", "record_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_actor_id_occurred_at_idx" ON "audit_log"("tenant_id", "actor_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_batch_tenant_id_last_seq_key" ON "audit_batch"("tenant_id", "last_seq");

-- CreateIndex
CREATE INDEX "audit_verification_tenant_id_started_at_idx" ON "audit_verification"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "setup_audit_tenant_id_occurred_at_idx" ON "setup_audit"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "setup_audit_tenant_id_entity_type_entity_id_idx" ON "setup_audit"("tenant_id", "entity_type", "entity_id");


-- ── Append-only ───────────────────────────────────────────────────────────────────────────
-- Nobody deletes audit rows, and the only update is sm_audit setting a row's hash exactly once;
-- any other change is rejected even for the owner. Batches, verifications and the setup audit
-- trail are append-only too.
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'sm_audit' AND OLD.hash IS NULL AND NEW.hash IS NOT NULL
     AND (to_jsonb(NEW) - 'hash' - 'prev_hash' - 'chained_at')
       = (to_jsonb(OLD) - 'hash' - 'prev_hash' - 'chained_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();

CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "audit_batch"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "audit_verification"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "setup_audit"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ── Privileges ────────────────────────────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log", "audit_batch", "audit_verification", "setup_audit" FROM sm_app;
GRANT SELECT, UPDATE ("prev_hash", "hash", "chained_at") ON "audit_log" TO sm_audit;
GRANT SELECT, INSERT ON "audit_batch" TO sm_audit;

-- ── Monthly partitions ────────────────────────────────────────────────────────────────────
-- Creates this month's partition and the next p_months_ahead (UTC), each with forced RLS, the
-- same privileges as the parent, and no retention drop (retention policies arrive with P12).
CREATE OR REPLACE FUNCTION audit_maintain_partitions(p_months_ahead int DEFAULT 3) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  first_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  m date;
  part text;
  made text[] := '{}';
BEGIN
  IF p_months_ahead NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'audit_maintain_partitions: months ahead must be 1-24';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log:partitions', 0));
  FOR m IN SELECT generate_series(first_month, first_month + make_interval(months => p_months_ahead), interval '1 month')::date LOOP
    part := 'audit_log_p' || to_char(m, 'YYYYMM');
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        part, (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      PERFORM enable_tenant_rls(format('public.%I', part)::regclass);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM sm_app', part);
      EXECUTE format('GRANT SELECT, UPDATE (prev_hash, hash, chained_at) ON public.%I TO sm_audit', part);
      made := made || part;
    END IF;
  END LOOP;
  RETURN made;
END
$$;
REVOKE ALL ON FUNCTION audit_maintain_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_maintain_partitions(int) TO sm_app;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
SELECT enable_tenant_rls('audit_log');
SELECT enable_tenant_rls('audit_batch');
SELECT enable_tenant_rls('audit_verification');
SELECT enable_tenant_rls('setup_audit');
SELECT audit_maintain_partitions();
