-- 0023_routing_sla_scoring — P03 T02: assignment rules, pools, cursors, capacity, availability and
-- skills, the assignment log (monthly partitions), business hours and holidays, SLA policies and
-- timers, lead recycling, scoring models and rules, score history (monthly partitions) and in-app
-- notifications. Additive (expand-only).

-- CreateEnum
CREATE TYPE "assignment_method" AS ENUM ('ROUND_ROBIN', 'WEIGHTED', 'LOAD_BALANCED', 'SKILLS_BASED', 'STICKY_ACCOUNT', 'QUEUE', 'SPECIFIC_USER');

-- CreateEnum
CREATE TYPE "pool_member_type" AS ENUM ('USER', 'QUEUE', 'ORG_UNIT');

-- CreateEnum
CREATE TYPE "sla_metric" AS ENUM ('FIRST_TOUCH', 'QUALIFY');

-- CreateEnum
CREATE TYPE "sla_status" AS ENUM ('RUNNING', 'MET', 'BREACHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "scoring_rule_kind" AS ENUM ('FIT', 'ENGAGEMENT');

-- CreateTable
CREATE TABLE "assignment_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "assignment_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "assignment_rule_entry" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "rule_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT,
    "criteria" JSONB,
    "formula" TEXT,
    "method" "assignment_method" NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "target_user_id" UUID,
    "target_queue_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "assignment_rule_entry_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "assignment_pool_member" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "entry_id" UUID NOT NULL,
    "member_type" "pool_member_type" NOT NULL,
    "user_id" UUID,
    "queue_id" UUID,
    "org_unit_id" UUID,
    "weight" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "assignment_pool_member_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "round_robin_cursor" (
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "last_user_id" UUID,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "turns" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "round_robin_cursor_pkey" PRIMARY KEY ("tenant_id","entry_id")
);

-- CreateTable
CREATE TABLE "user_capacity" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "max_open" INTEGER,
    "max_new_per_day" INTEGER,

    CONSTRAINT "user_capacity_pkey" PRIMARY KEY ("tenant_id","user_id","object")
);

-- CreateTable
CREATE TABLE "user_availability" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "working_hours" JSONB,
    "out_of_office" BOOLEAN NOT NULL DEFAULT false,
    "ooo_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_availability_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "user_skill" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "skill" TEXT NOT NULL,

    CONSTRAINT "user_skill_pkey" PRIMARY KEY ("tenant_id","user_id","skill")
);

-- CreateTable
CREATE TABLE "assignment_log" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "object" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "rule_id" UUID,
    "entry_id" UUID,
    "method" "assignment_method",
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "previous_owner_id" UUID,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor_id" UUID,

    CONSTRAINT "assignment_log_pkey" PRIMARY KEY ("tenant_id","assigned_at","id")
) PARTITION BY RANGE ("assigned_at");

-- CreateTable
CREATE TABLE "business_hours" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "hours" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "holiday" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "business_hours_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "sla_policy" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL DEFAULT 'lead',
    "name" TEXT NOT NULL,
    "metric" "sla_metric" NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "business_hours_id" UUID,
    "owner_timezone" BOOLEAN NOT NULL DEFAULT false,
    "criteria" JSONB,
    "warn_at_percent" INTEGER DEFAULT 50,
    "manager_at_percent" INTEGER DEFAULT 100,
    "reassign_at_percent" INTEGER,
    "reassign_rule_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sla_policy_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "sla_timer" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "policy_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "warn_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "reassign_at" TIMESTAMPTZ(6),
    "next_action_at" TIMESTAMPTZ(6),
    "status" "sla_status" NOT NULL DEFAULT 'RUNNING',
    "steps_done" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "met_at" TIMESTAMPTZ(6),
    "breached_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sla_timer_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "recycle_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL DEFAULT 'lead',
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "from_categories" TEXT[],
    "after_days" INTEGER NOT NULL,
    "criteria" JSONB,
    "target_status" TEXT NOT NULL,
    "assignment_rule_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "recycle_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "scoring_model" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL DEFAULT 'lead',
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "fit_weight" INTEGER NOT NULL DEFAULT 60,
    "engagement_half_life_days" INTEGER NOT NULL DEFAULT 14,
    "grade_bands" JSONB NOT NULL DEFAULT '{"A":75,"B":50,"C":25}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "scoring_model_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "scoring_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "model_id" UUID NOT NULL,
    "kind" "scoring_rule_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "formula" TEXT,
    "event" TEXT,
    "points" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scoring_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "score_history" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "object" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "fit" INTEGER NOT NULL,
    "engagement" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "reason" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "score_history_pkey" PRIMARY KEY ("tenant_id","changed_at","id")
) PARTITION BY RANGE ("changed_at");

-- CreateTable
CREATE TABLE "notification" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "object" TEXT,
    "record_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assignment_rule_tenant_id_object_name_key" ON "assignment_rule"("tenant_id", "object", "name");

-- CreateIndex
CREATE INDEX "assignment_rule_entry_tenant_id_rule_id_sort_order_idx" ON "assignment_rule_entry"("tenant_id", "rule_id", "sort_order");

-- CreateIndex
CREATE INDEX "assignment_pool_member_tenant_id_entry_id_idx" ON "assignment_pool_member"("tenant_id", "entry_id");

-- CreateIndex
CREATE INDEX "user_skill_tenant_id_skill_idx" ON "user_skill"("tenant_id", "skill");

-- CreateIndex
CREATE INDEX "assignment_log_tenant_id_object_record_id_assigned_at_idx" ON "assignment_log"("tenant_id", "object", "record_id", "assigned_at");

-- CreateIndex
CREATE UNIQUE INDEX "business_hours_tenant_id_name_key" ON "business_hours"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_tenant_id_business_hours_id_date_key" ON "holiday"("tenant_id", "business_hours_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policy_tenant_id_object_name_key" ON "sla_policy"("tenant_id", "object", "name");

-- CreateIndex
CREATE INDEX "sla_timer_tenant_id_object_record_id_idx" ON "sla_timer"("tenant_id", "object", "record_id");

-- CreateIndex
CREATE INDEX "sla_timer_tenant_id_status_next_action_at_idx" ON "sla_timer"("tenant_id", "status", "next_action_at");

-- CreateIndex
CREATE INDEX "sla_timer_tenant_id_owner_id_status_idx" ON "sla_timer"("tenant_id", "owner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recycle_rule_tenant_id_object_name_key" ON "recycle_rule"("tenant_id", "object", "name");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_model_tenant_id_object_name_key" ON "scoring_model"("tenant_id", "object", "name");

-- CreateIndex
CREATE INDEX "scoring_rule_tenant_id_model_id_idx" ON "scoring_rule"("tenant_id", "model_id");

-- CreateIndex
CREATE INDEX "score_history_tenant_id_object_record_id_changed_at_idx" ON "score_history"("tenant_id", "object", "record_id", "changed_at");

-- CreateIndex
CREATE INDEX "notification_tenant_id_user_id_read_at_created_at_idx" ON "notification"("tenant_id", "user_id", "read_at", "created_at");

-- AddForeignKey
ALTER TABLE "assignment_rule_entry" ADD CONSTRAINT "assignment_rule_entry_tenant_id_rule_id_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "assignment_rule"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_pool_member" ADD CONSTRAINT "assignment_pool_member_tenant_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "assignment_rule_entry"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_robin_cursor" ADD CONSTRAINT "round_robin_cursor_tenant_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "assignment_rule_entry"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_tenant_id_business_hours_id_fkey" FOREIGN KEY ("tenant_id", "business_hours_id") REFERENCES "business_hours"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_timer" ADD CONSTRAINT "sla_timer_tenant_id_policy_id_fkey" FOREIGN KEY ("tenant_id", "policy_id") REFERENCES "sla_policy"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_rule" ADD CONSTRAINT "scoring_rule_tenant_id_model_id_fkey" FOREIGN KEY ("tenant_id", "model_id") REFERENCES "scoring_model"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Monthly partitions for the append-only logs ─────────────────────────────────────────────
-- One function for every log added from P03 on (field_history and audit_log keep their own):
-- this month and the next p_months_ahead (UTC), each with forced RLS and no UPDATE/DELETE for the
-- runtime role. Only allow-listed parents; retention drops arrive with P12.
CREATE OR REPLACE FUNCTION maintain_monthly_partitions(p_parent text, p_months_ahead int DEFAULT 3)
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  first_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  m date;
  part text;
  made text[] := '{}';
BEGIN
  IF p_parent NOT IN ('assignment_log', 'score_history') THEN
    RAISE EXCEPTION 'maintain_monthly_partitions: % is not a partitioned log', p_parent;
  END IF;
  IF p_months_ahead NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'maintain_monthly_partitions: months ahead must be 1-24';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_parent || ':partitions', 0));
  FOR m IN SELECT generate_series(first_month, first_month + make_interval(months => p_months_ahead), interval '1 month')::date LOOP
    part := p_parent || '_p' || to_char(m, 'YYYYMM');
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part, p_parent, (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      PERFORM enable_tenant_rls(format('public.%I', part)::regclass);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM sm_app', part);
      made := made || part;
    END IF;
  END LOOP;
  RETURN made;
END
$$;
REVOKE ALL ON FUNCTION maintain_monthly_partitions(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintain_monthly_partitions(text, int) TO sm_app;

CREATE TRIGGER assignment_log_no_truncate BEFORE TRUNCATE ON "assignment_log"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
REVOKE UPDATE, DELETE, TRUNCATE ON "assignment_log" FROM sm_app;
CREATE TRIGGER score_history_no_truncate BEFORE TRUNCATE ON "score_history"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
REVOKE UPDATE, DELETE, TRUNCATE ON "score_history" FROM sm_app;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "assignment_rule" ADD CONSTRAINT "assignment_rule_object" CHECK ("object" IN ('lead', 'contact', 'account', 'opportunity'));
-- At most one default rule per object.
CREATE UNIQUE INDEX "assignment_rule_one_default" ON "assignment_rule" ("tenant_id", "object") WHERE "is_default";
ALTER TABLE "assignment_rule_entry" ADD CONSTRAINT "assignment_rule_entry_target" CHECK (
  ("method" <> 'SPECIFIC_USER' OR "target_user_id" IS NOT NULL) AND
  ("method" <> 'QUEUE' OR "target_queue_id" IS NOT NULL));
ALTER TABLE "assignment_pool_member" ADD CONSTRAINT "assignment_pool_member_ref" CHECK (
  ("member_type" = 'USER' AND "user_id" IS NOT NULL AND "queue_id" IS NULL AND "org_unit_id" IS NULL) OR
  ("member_type" = 'QUEUE' AND "queue_id" IS NOT NULL AND "user_id" IS NULL AND "org_unit_id" IS NULL) OR
  ("member_type" = 'ORG_UNIT' AND "org_unit_id" IS NOT NULL AND "user_id" IS NULL AND "queue_id" IS NULL));
ALTER TABLE "assignment_pool_member" ADD CONSTRAINT "assignment_pool_member_weight" CHECK ("weight" > 0);
ALTER TABLE "user_capacity" ADD CONSTRAINT "user_capacity_limits" CHECK (
  ("max_open" IS NULL OR "max_open" >= 0) AND ("max_new_per_day" IS NULL OR "max_new_per_day" >= 0));
ALTER TABLE "assignment_log" ADD CONSTRAINT "assignment_log_owner_type" CHECK ("owner_type" IN ('USER', 'QUEUE'));
CREATE UNIQUE INDEX "business_hours_one_default" ON "business_hours" ("tenant_id") WHERE "is_default";
ALTER TABLE "sla_policy" ADD CONSTRAINT "sla_policy_target" CHECK ("target_minutes" > 0);
ALTER TABLE "sla_policy" ADD CONSTRAINT "sla_policy_ladder" CHECK (
  ("warn_at_percent" IS NULL OR "warn_at_percent" BETWEEN 1 AND 99) AND
  ("manager_at_percent" IS NULL OR "manager_at_percent" BETWEEN 1 AND 500) AND
  ("reassign_at_percent" IS NULL OR ("reassign_at_percent" BETWEEN 1 AND 500 AND "reassign_rule_id" IS NOT NULL)));
ALTER TABLE "recycle_rule" ADD CONSTRAINT "recycle_rule_days" CHECK ("after_days" BETWEEN 1 AND 3650);
ALTER TABLE "recycle_rule" ADD CONSTRAINT "recycle_rule_categories" CHECK (
  cardinality("from_categories") > 0 AND "from_categories" <@ ARRAY['UNQUALIFIED', 'NURTURE']::text[]);
ALTER TABLE "scoring_model" ADD CONSTRAINT "scoring_model_weights" CHECK (
  "fit_weight" BETWEEN 0 AND 100 AND "engagement_half_life_days" BETWEEN 1 AND 365);
CREATE UNIQUE INDEX "scoring_model_one_primary" ON "scoring_model" ("tenant_id", "object") WHERE "is_primary";
ALTER TABLE "scoring_rule" ADD CONSTRAINT "scoring_rule_kind_fields" CHECK (
  ("kind" = 'FIT' AND "formula" IS NOT NULL) OR ("kind" = 'ENGAGEMENT' AND "event" IS NOT NULL));
ALTER TABLE "scoring_rule" ADD CONSTRAINT "scoring_rule_points" CHECK ("points" BETWEEN -100 AND 100);
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_range" CHECK (
  "fit" BETWEEN 0 AND 100 AND "engagement" BETWEEN 0 AND 100 AND "score" BETWEEN 0 AND 100 AND "grade" IN ('A', 'B', 'C', 'D'));

-- ── Row-level security on every new table ───────────────────────────────────────────────────
SELECT enable_tenant_rls('assignment_rule');
SELECT enable_tenant_rls('assignment_rule_entry');
SELECT enable_tenant_rls('assignment_pool_member');
SELECT enable_tenant_rls('round_robin_cursor');
SELECT enable_tenant_rls('user_capacity');
SELECT enable_tenant_rls('user_availability');
SELECT enable_tenant_rls('user_skill');
SELECT enable_tenant_rls('assignment_log');
SELECT enable_tenant_rls('business_hours');
SELECT enable_tenant_rls('holiday');
SELECT enable_tenant_rls('sla_policy');
SELECT enable_tenant_rls('sla_timer');
SELECT enable_tenant_rls('recycle_rule');
SELECT enable_tenant_rls('scoring_model');
SELECT enable_tenant_rls('scoring_rule');
SELECT enable_tenant_rls('score_history');
SELECT enable_tenant_rls('notification');

SELECT maintain_monthly_partitions('assignment_log');
SELECT maintain_monthly_partitions('score_history');
