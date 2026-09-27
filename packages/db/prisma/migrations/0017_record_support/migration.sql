-- 0017_record_support — P02 T06: field history (monthly partitions), the recycle bin, recent
-- items, currencies and dated rates, account and opportunity teams, and custom-field index
-- requests. Additive (expand-only).

-- CreateEnum
CREATE TYPE "custom_field_index_status" AS ENUM ('PENDING', 'BUILDING', 'READY', 'FAILED', 'DROPPING');

-- CreateTable
CREATE TABLE "field_history" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "object" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "changed_by" UUID,
    "request_id" TEXT,

    CONSTRAINT "field_history_pkey" PRIMARY KEY ("tenant_id","changed_at","id")
) PARTITION BY RANGE ("changed_at");

-- CreateTable
CREATE TABLE "recycle_bin_item" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by" UUID,
    "cascade_of" UUID,
    "purge_after" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recycle_bin_item_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "recent_item" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recent_item_pkey" PRIMARY KEY ("tenant_id","user_id","object","record_id")
);

-- CreateTable
CREATE TABLE "tenant_currency" (
    "tenant_id" UUID NOT NULL,
    "code" CHAR(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "tenant_currency_pkey" PRIMARY KEY ("tenant_id","code")
);

-- CreateTable
CREATE TABLE "currency_rate" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "code" CHAR(3) NOT NULL,
    "effective_date" DATE NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "currency_rate_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "account_team_member" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "account_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT,
    "access" SMALLINT NOT NULL DEFAULT 1,
    "opportunity_access" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "account_team_member_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "opportunity_team_member" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "opportunity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT,
    "access" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "opportunity_team_member_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "custom_field_index" (
    "tenant_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "status" "custom_field_index_status" NOT NULL DEFAULT 'PENDING',
    "index_name" TEXT NOT NULL,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(6),

    CONSTRAINT "custom_field_index_pkey" PRIMARY KEY ("tenant_id","field_id")
);

-- CreateIndex
CREATE INDEX "field_history_tenant_id_object_record_id_changed_at_idx" ON "field_history"("tenant_id", "object", "record_id", "changed_at");

-- CreateIndex
CREATE INDEX "recycle_bin_item_tenant_id_deleted_by_deleted_at_idx" ON "recycle_bin_item"("tenant_id", "deleted_by", "deleted_at");

-- CreateIndex
CREATE INDEX "recycle_bin_item_tenant_id_purge_after_idx" ON "recycle_bin_item"("tenant_id", "purge_after");

-- CreateIndex
CREATE INDEX "recycle_bin_item_tenant_id_cascade_of_idx" ON "recycle_bin_item"("tenant_id", "cascade_of");

-- CreateIndex
CREATE UNIQUE INDEX "recycle_bin_item_tenant_id_object_record_id_key" ON "recycle_bin_item"("tenant_id", "object", "record_id");

-- CreateIndex
CREATE INDEX "recent_item_tenant_id_user_id_viewed_at_idx" ON "recent_item"("tenant_id", "user_id", "viewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "currency_rate_tenant_id_code_effective_date_key" ON "currency_rate"("tenant_id", "code", "effective_date");

-- CreateIndex
CREATE INDEX "account_team_member_tenant_id_user_id_idx" ON "account_team_member"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_team_member_tenant_id_account_id_user_id_key" ON "account_team_member"("tenant_id", "account_id", "user_id");

-- CreateIndex
CREATE INDEX "opportunity_team_member_tenant_id_user_id_idx" ON "opportunity_team_member"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_team_member_tenant_id_opportunity_id_user_id_key" ON "opportunity_team_member"("tenant_id", "opportunity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_index_tenant_id_index_name_key" ON "custom_field_index"("tenant_id", "index_name");

-- AddForeignKey
ALTER TABLE "tenant_currency" ADD CONSTRAINT "tenant_currency_code_fkey" FOREIGN KEY ("code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "currency_rate" ADD CONSTRAINT "currency_rate_positive" CHECK ("rate" > 0);
ALTER TABLE "account_team_member" ADD CONSTRAINT "account_team_member_access"
  CHECK ("access" IN (1, 2) AND "opportunity_access" IN (0, 1, 2));
ALTER TABLE "opportunity_team_member" ADD CONSTRAINT "opportunity_team_member_access"
  CHECK ("access" IN (1, 2));
ALTER TABLE "recycle_bin_item" ADD CONSTRAINT "recycle_bin_item_purge_after"
  CHECK ("purge_after" > "deleted_at");

-- ── Field history is append-only (§7.17) ────────────────────────────────────────────────────
CREATE TRIGGER field_history_no_truncate BEFORE TRUNCATE ON "field_history"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
REVOKE UPDATE, DELETE, TRUNCATE ON "field_history" FROM sm_app;

-- Monthly partitions of field_history: this month and the next p_months_ahead (UTC), each with
-- forced RLS and the parent's privileges. Retention (24 months by default, §7.17) drops old
-- partitions from P12's retention policies; nothing is dropped here.
CREATE OR REPLACE FUNCTION field_history_maintain_partitions(p_months_ahead int DEFAULT 3) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  first_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  m date;
  part text;
  made text[] := '{}';
BEGIN
  IF p_months_ahead NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'field_history_maintain_partitions: months ahead must be 1-24';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('field_history:partitions', 0));
  FOR m IN SELECT generate_series(first_month, first_month + make_interval(months => p_months_ahead), interval '1 month')::date LOOP
    part := 'field_history_p' || to_char(m, 'YYYYMM');
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF field_history FOR VALUES FROM (%L) TO (%L)',
        part, (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      PERFORM enable_tenant_rls(format('public.%I', part)::regclass);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM sm_app', part);
      made := made || part;
    END IF;
  END LOOP;
  RETURN made;
END
$$;
REVOKE ALL ON FUNCTION field_history_maintain_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION field_history_maintain_partitions(int) TO sm_app;

SELECT enable_tenant_rls('field_history');
SELECT enable_tenant_rls('recycle_bin_item');
SELECT enable_tenant_rls('recent_item');
SELECT enable_tenant_rls('tenant_currency');
SELECT enable_tenant_rls('currency_rate');
SELECT enable_tenant_rls('account_team_member');
SELECT enable_tenant_rls('opportunity_team_member');
SELECT enable_tenant_rls('custom_field_index');
SELECT field_history_maintain_partitions();
