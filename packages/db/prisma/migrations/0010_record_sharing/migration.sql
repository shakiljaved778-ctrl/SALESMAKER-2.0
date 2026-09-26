-- 0010_record_sharing — P01 T09: explicit record shares, sharing rules and job progress (§6.3,
-- §6.4). Additive (expand-only).
-- CreateEnum
CREATE TYPE "share_principal_type" AS ENUM ('USER', 'GROUP', 'QUEUE', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES');

-- CreateEnum
CREATE TYPE "share_reason" AS ENUM ('RULE', 'MANUAL', 'TEAM', 'TERRITORY', 'IMPLICIT_PARENT', 'IMPLICIT_CHILD');

-- CreateEnum
CREATE TYPE "sharing_rule_kind" AS ENUM ('OWNER', 'CRITERIA');

-- CreateEnum
CREATE TYPE "job_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "record_share" (
    "tenant_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_id" UUID NOT NULL,
    "principal_type" "share_principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "access" SMALLINT NOT NULL,
    "reason" "share_reason" NOT NULL,
    "source_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "record_share_pkey" PRIMARY KEY ("tenant_id","object","id")
) PARTITION BY LIST ("object");

-- CreateTable
CREATE TABLE "sharing_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "sharing_rule_kind" NOT NULL,
    "source_type" "share_principal_type",
    "source_id" UUID,
    "criteria" JSONB,
    "target_type" "share_principal_type" NOT NULL,
    "target_id" UUID NOT NULL,
    "access" SMALLINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sharing_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "job_run" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "kind" TEXT NOT NULL,
    "subject_id" UUID,
    "status" "job_run_status" NOT NULL DEFAULT 'QUEUED',
    "done" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "record_share_tenant_id_object_principal_id_record_id_idx" ON "record_share"("tenant_id", "object", "principal_id", "record_id");

-- CreateIndex
CREATE INDEX "record_share_tenant_id_object_reason_source_id_idx" ON "record_share"("tenant_id", "object", "reason", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_share_tenant_id_object_record_id_principal_type_prin_key" ON "record_share"("tenant_id", "object", "record_id", "principal_type", "principal_id", "reason", "source_id");

-- CreateIndex
CREATE INDEX "sharing_rule_tenant_id_object_active_idx" ON "sharing_rule"("tenant_id", "object", "active");

-- CreateIndex
CREATE UNIQUE INDEX "sharing_rule_tenant_id_object_name_key" ON "sharing_rule"("tenant_id", "object", "name");

-- CreateIndex
CREATE INDEX "job_run_tenant_id_kind_subject_id_created_at_idx" ON "job_run"("tenant_id", "kind", "subject_id", "created_at");


-- ── Invariants ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "record_share" ADD CONSTRAINT "record_share_access" CHECK ("access" BETWEEN 1 AND 3);
ALTER TABLE "record_share" ADD CONSTRAINT "record_share_manual_source" CHECK (
  "reason" <> 'MANUAL' OR "source_id" = '00000000-0000-0000-0000-000000000000');
ALTER TABLE "sharing_rule" ADD CONSTRAINT "sharing_rule_access" CHECK ("access" IN (1, 2));
ALTER TABLE "sharing_rule" ADD CONSTRAINT "sharing_rule_shape" CHECK (
  CASE "kind"
    WHEN 'OWNER' THEN "source_type" IN ('GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES')
      AND "source_id" IS NOT NULL AND "criteria" IS NULL
    ELSE "criteria" IS NOT NULL AND "source_type" IS NULL AND "source_id" IS NULL
  END);
ALTER TABLE "sharing_rule" ADD CONSTRAINT "sharing_rule_target" CHECK (
  "target_type" IN ('GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES'));
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_progress" CHECK (
  "done" >= 0 AND ("total" IS NULL OR "total" >= 0));

-- ── record_share partitions ────────────────────────────────────────────────────────────────
-- One partition per object keeps each object's shares (and their indexes) apart, so a big
-- object never slows another's predicate. record_share_ensure_partition(object) adds one for a
-- new object (P02 custom objects); until then its shares land in the default partition. Every
-- partition gets forced RLS and the tenant_isolation policy (the RLS audit checks partitions).
CREATE OR REPLACE FUNCTION record_share_ensure_partition(p_object text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  part text := 'record_share_' || p_object;
BEGIN
  IF p_object !~ '^[a-z][a-z0-9_]{0,40}$' THEN
    RAISE EXCEPTION 'record_share_ensure_partition: invalid object api name %', p_object;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('record_share:partitions', 0));
  IF to_regclass(format('public.%I', part)) IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I PARTITION OF record_share FOR VALUES IN (%L)', part, p_object);
    PERFORM enable_tenant_rls(format('public.%I', part)::regclass);
  END IF;
  RETURN part;
END
$$;
REVOKE ALL ON FUNCTION record_share_ensure_partition(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_share_ensure_partition(text) TO sm_app;

CREATE TABLE "record_share_default" PARTITION OF "record_share" DEFAULT;
SELECT enable_tenant_rls('record_share');
SELECT enable_tenant_rls('record_share_default');
SELECT record_share_ensure_partition(o) FROM unnest(ARRAY[
  'lead', 'account', 'contact', 'opportunity', 'campaign', 'product', 'quote', 'contract', 'order',
  'activity']) AS o;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
SELECT enable_tenant_rls('sharing_rule');
SELECT enable_tenant_rls('job_run');
