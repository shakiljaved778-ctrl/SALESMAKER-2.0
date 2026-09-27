-- 0016_core_crm — P02 T05: the core CRM objects (§4): lead, account, contact, opportunity and
-- campaign, with pipelines and stages, account-contact relations, contact roles, stage history,
-- campaign members and lead conversions. Additive (expand-only).

-- CreateTable
CREATE TABLE "lead" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_number" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "record_type_id" UUID,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "first_name" TEXT,
    "last_name" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile_phone" TEXT,
    "website" TEXT,
    "status" TEXT NOT NULL,
    "unqualified_reason" TEXT,
    "rating" TEXT,
    "lead_source" TEXT,
    "industry" TEXT,
    "annual_revenue" DECIMAL(18,2),
    "annual_revenue_corporate" DECIMAL(18,2),
    "number_of_employees" INTEGER,
    "street" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "description" TEXT,
    "campaign_id" UUID,
    "do_not_call" BOOLEAN NOT NULL DEFAULT false,
    "email_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "converted_at" TIMESTAMPTZ(6),
    "converted_account_id" UUID,
    "converted_contact_id" UUID,
    "converted_opportunity_id" UUID,
    "currency_code" CHAR(3) NOT NULL,
    "corporate_rate_date" DATE,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "search_vector" tsvector,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lead_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "account" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_number" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "record_type_id" UUID,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "name" TEXT NOT NULL,
    "parent_account_id" UUID,
    "type" TEXT,
    "industry" TEXT,
    "rating" TEXT,
    "annual_revenue" DECIMAL(18,2),
    "annual_revenue_corporate" DECIMAL(18,2),
    "number_of_employees" INTEGER,
    "website" TEXT,
    "phone" TEXT,
    "billing_street" TEXT,
    "billing_city" TEXT,
    "billing_state" TEXT,
    "billing_postal_code" TEXT,
    "billing_country" TEXT,
    "shipping_street" TEXT,
    "shipping_city" TEXT,
    "shipping_state" TEXT,
    "shipping_postal_code" TEXT,
    "shipping_country" TEXT,
    "description" TEXT,
    "currency_code" CHAR(3) NOT NULL,
    "corporate_rate_date" DATE,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "search_vector" tsvector,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "contact" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_number" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "record_type_id" UUID,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "first_name" TEXT,
    "last_name" TEXT NOT NULL,
    "account_id" UUID,
    "title" TEXT,
    "department" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile_phone" TEXT,
    "reports_to_id" UUID,
    "lead_source" TEXT,
    "birthdate" DATE,
    "mailing_street" TEXT,
    "mailing_city" TEXT,
    "mailing_state" TEXT,
    "mailing_postal_code" TEXT,
    "mailing_country" TEXT,
    "description" TEXT,
    "do_not_call" BOOLEAN NOT NULL DEFAULT false,
    "email_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "search_vector" tsvector,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contact_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "opportunity" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_number" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "record_type_id" UUID,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "name" TEXT NOT NULL,
    "account_id" UUID,
    "primary_contact_id" UUID,
    "pipeline_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "probability" DECIMAL(5,2),
    "forecast_category" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "amount_corporate" DECIMAL(18,2),
    "close_date" DATE NOT NULL,
    "next_step" TEXT,
    "type" TEXT,
    "lead_source" TEXT,
    "campaign_id" UUID,
    "loss_reason" TEXT,
    "competitors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "is_won" BOOLEAN NOT NULL DEFAULT false,
    "currency_code" CHAR(3) NOT NULL,
    "corporate_rate_date" DATE,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "search_vector" tsvector,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "opportunity_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "campaign" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_number" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "record_type_id" UUID,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "name" TEXT NOT NULL,
    "parent_campaign_id" UUID,
    "type" TEXT,
    "status" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "start_date" DATE,
    "end_date" DATE,
    "budgeted_cost" DECIMAL(18,2),
    "budgeted_cost_corporate" DECIMAL(18,2),
    "actual_cost" DECIMAL(18,2),
    "actual_cost_corporate" DECIMAL(18,2),
    "expected_revenue" DECIMAL(18,2),
    "expected_revenue_corporate" DECIMAL(18,2),
    "description" TEXT,
    "number_of_leads" INTEGER NOT NULL DEFAULT 0,
    "number_of_opportunities" INTEGER NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "corporate_rate_date" DATE,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "search_vector" tsvector,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "pipeline" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pipeline_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "pipeline_stage" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "pipeline_id" UUID NOT NULL,
    "api_value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'OPEN',
    "probability" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "forecast_category" TEXT NOT NULL DEFAULT 'pipeline',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pipeline_stage_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "account_contact_relation" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_direct" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "start_date" DATE,
    "end_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "account_contact_relation_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "opportunity_contact_role" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "opportunity_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "opportunity_contact_role_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "opportunity_stage_history" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "opportunity_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "currency_code" CHAR(3) NOT NULL,
    "close_date" DATE NOT NULL,
    "forecast_category" TEXT NOT NULL,
    "probability" DECIMAL(5,2),
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" UUID,

    CONSTRAINT "opportunity_stage_history_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "campaign_member" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "campaign_id" UUID NOT NULL,
    "lead_id" UUID,
    "contact_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "responded" BOOLEAN NOT NULL DEFAULT false,
    "first_responded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "campaign_member_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "lead_conversion" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "lead_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "opportunity_id" UUID,
    "created_account" BOOLEAN NOT NULL,
    "created_contact" BOOLEAN NOT NULL,
    "lead_before" JSONB NOT NULL,
    "converted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "converted_by" UUID,
    "undone_at" TIMESTAMPTZ(6),
    "undone_by" UUID,

    CONSTRAINT "lead_conversion_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_idx" ON "lead"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_last_name_id_idx" ON "lead"("tenant_id", "last_name", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_last_name_id_idx" ON "lead"("tenant_id", "owner_id", "last_name", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_company_id_idx" ON "lead"("tenant_id", "company", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_company_id_idx" ON "lead"("tenant_id", "owner_id", "company", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_email_id_idx" ON "lead"("tenant_id", "email", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_email_id_idx" ON "lead"("tenant_id", "owner_id", "email", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_status_id_idx" ON "lead"("tenant_id", "status", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_status_id_idx" ON "lead"("tenant_id", "owner_id", "status", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_lead_source_id_idx" ON "lead"("tenant_id", "lead_source", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_lead_source_id_idx" ON "lead"("tenant_id", "owner_id", "lead_source", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_created_at_id_idx" ON "lead"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_created_at_id_idx" ON "lead"("tenant_id", "owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_updated_at_id_idx" ON "lead"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_updated_at_id_idx" ON "lead"("tenant_id", "owner_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_campaign_id_idx" ON "lead"("tenant_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tenant_id_record_number_key" ON "lead"("tenant_id", "record_number");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tenant_id_external_id_key" ON "lead"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "account_tenant_id_owner_id_idx" ON "account"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "account_tenant_id_name_id_idx" ON "account"("tenant_id", "name", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_owner_id_name_id_idx" ON "account"("tenant_id", "owner_id", "name", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_type_id_idx" ON "account"("tenant_id", "type", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_owner_id_type_id_idx" ON "account"("tenant_id", "owner_id", "type", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_industry_id_idx" ON "account"("tenant_id", "industry", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_owner_id_industry_id_idx" ON "account"("tenant_id", "owner_id", "industry", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_created_at_id_idx" ON "account"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_owner_id_created_at_id_idx" ON "account"("tenant_id", "owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_updated_at_id_idx" ON "account"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_owner_id_updated_at_id_idx" ON "account"("tenant_id", "owner_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "account_tenant_id_parent_account_id_idx" ON "account"("tenant_id", "parent_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_tenant_id_record_number_key" ON "account"("tenant_id", "record_number");

-- CreateIndex
CREATE UNIQUE INDEX "account_tenant_id_external_id_key" ON "account"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_owner_id_idx" ON "contact"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_last_name_id_idx" ON "contact"("tenant_id", "last_name", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_owner_id_last_name_id_idx" ON "contact"("tenant_id", "owner_id", "last_name", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_email_id_idx" ON "contact"("tenant_id", "email", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_owner_id_email_id_idx" ON "contact"("tenant_id", "owner_id", "email", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_created_at_id_idx" ON "contact"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_owner_id_created_at_id_idx" ON "contact"("tenant_id", "owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_updated_at_id_idx" ON "contact"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_owner_id_updated_at_id_idx" ON "contact"("tenant_id", "owner_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_account_id_idx" ON "contact"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_reports_to_id_idx" ON "contact"("tenant_id", "reports_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenant_id_record_number_key" ON "contact"("tenant_id", "record_number");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenant_id_external_id_key" ON "contact"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_idx" ON "opportunity"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_name_id_idx" ON "opportunity"("tenant_id", "name", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_name_id_idx" ON "opportunity"("tenant_id", "owner_id", "name", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_stage_id_idx" ON "opportunity"("tenant_id", "stage", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_stage_id_idx" ON "opportunity"("tenant_id", "owner_id", "stage", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_amount_id_idx" ON "opportunity"("tenant_id", "amount", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_amount_id_idx" ON "opportunity"("tenant_id", "owner_id", "amount", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_close_date_id_idx" ON "opportunity"("tenant_id", "close_date", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_close_date_id_idx" ON "opportunity"("tenant_id", "owner_id", "close_date", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_created_at_id_idx" ON "opportunity"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_created_at_id_idx" ON "opportunity"("tenant_id", "owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_updated_at_id_idx" ON "opportunity"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_owner_id_updated_at_id_idx" ON "opportunity"("tenant_id", "owner_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_account_id_idx" ON "opportunity"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_primary_contact_id_idx" ON "opportunity"("tenant_id", "primary_contact_id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_campaign_id_idx" ON "opportunity"("tenant_id", "campaign_id");

-- CreateIndex
CREATE INDEX "opportunity_tenant_id_pipeline_id_idx" ON "opportunity"("tenant_id", "pipeline_id");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_tenant_id_record_number_key" ON "opportunity"("tenant_id", "record_number");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_tenant_id_external_id_key" ON "opportunity"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_owner_id_idx" ON "campaign"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_name_id_idx" ON "campaign"("tenant_id", "name", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_owner_id_name_id_idx" ON "campaign"("tenant_id", "owner_id", "name", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_status_id_idx" ON "campaign"("tenant_id", "status", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_owner_id_status_id_idx" ON "campaign"("tenant_id", "owner_id", "status", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_start_date_id_idx" ON "campaign"("tenant_id", "start_date", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_owner_id_start_date_id_idx" ON "campaign"("tenant_id", "owner_id", "start_date", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_created_at_id_idx" ON "campaign"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_owner_id_created_at_id_idx" ON "campaign"("tenant_id", "owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_updated_at_id_idx" ON "campaign"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_owner_id_updated_at_id_idx" ON "campaign"("tenant_id", "owner_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "campaign_tenant_id_parent_campaign_id_idx" ON "campaign"("tenant_id", "parent_campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_tenant_id_record_number_key" ON "campaign"("tenant_id", "record_number");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_tenant_id_external_id_key" ON "campaign"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_tenant_id_name_key" ON "pipeline"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stage_tenant_id_pipeline_id_api_value_key" ON "pipeline_stage"("tenant_id", "pipeline_id", "api_value");

-- CreateIndex
CREATE INDEX "account_contact_relation_tenant_id_contact_id_idx" ON "account_contact_relation"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_contact_relation_tenant_id_account_id_contact_id_key" ON "account_contact_relation"("tenant_id", "account_id", "contact_id");

-- CreateIndex
CREATE INDEX "opportunity_contact_role_tenant_id_contact_id_idx" ON "opportunity_contact_role"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_contact_role_tenant_id_opportunity_id_contact_i_key" ON "opportunity_contact_role"("tenant_id", "opportunity_id", "contact_id");

-- CreateIndex
CREATE INDEX "opportunity_stage_history_tenant_id_opportunity_id_changed__idx" ON "opportunity_stage_history"("tenant_id", "opportunity_id", "changed_at");

-- CreateIndex
CREATE INDEX "campaign_member_tenant_id_lead_id_idx" ON "campaign_member"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "campaign_member_tenant_id_contact_id_idx" ON "campaign_member"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_member_tenant_id_campaign_id_lead_id_key" ON "campaign_member"("tenant_id", "campaign_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_member_tenant_id_campaign_id_contact_id_key" ON "campaign_member"("tenant_id", "campaign_id", "contact_id");

-- CreateIndex
CREATE INDEX "lead_conversion_tenant_id_lead_id_idx" ON "lead_conversion"("tenant_id", "lead_id");

-- AddForeignKey
ALTER TABLE "record_type" ADD CONSTRAINT "record_type_tenant_id_pipeline_id_fkey" FOREIGN KEY ("tenant_id", "pipeline_id") REFERENCES "pipeline"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_tenant_id_pipeline_id_fkey" FOREIGN KEY ("tenant_id", "pipeline_id") REFERENCES "pipeline"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead', 'account', 'contact', 'opportunity', 'campaign'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (version >= 1)', t, t || '_version');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (jsonb_typeof(custom) = ''object'')', t, t || '_custom_object');
  END LOOP;
END
$$;
ALTER TABLE "lead" ADD CONSTRAINT "lead_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "account" ADD CONSTRAINT "account_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_probability" CHECK ("probability" BETWEEN 0 AND 100);
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_category" CHECK ("category" IN ('OPEN', 'WON', 'LOST'));
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_probability" CHECK ("probability" BETWEEN 0 AND 100);
ALTER TABLE "campaign_member" ADD CONSTRAINT "campaign_member_one_person"
  CHECK (("lead_id" IS NULL) <> ("contact_id" IS NULL));
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_currency"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');
CREATE UNIQUE INDEX "pipeline_one_default" ON "pipeline" ("tenant_id") WHERE "is_default";
CREATE UNIQUE INDEX "opportunity_contact_role_one_primary" ON "opportunity_contact_role" ("tenant_id", "opportunity_id") WHERE "is_primary";
-- Stage history is append-only.
REVOKE UPDATE, DELETE ON "opportunity_stage_history" FROM sm_app;

-- ── Search (§7.19) ──────────────────────────────────────────────────────────────────────────
-- The document holds the record name (weight A) and, for leads, the company (B): fields every
-- reader can see. Fields that field-level security can hide (email, phone, …) are matched per
-- column at query time, only when the searcher can read them (T14), so a hidden field never
-- decides whether a record is found (§6.5).
CREATE OR REPLACE FUNCTION crm_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Separate branches: PL/pgSQL resolves NEW.<column> only in the branch that runs.
  IF TG_TABLE_NAME = 'lead' THEN
    NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(NEW.company, '')), 'B');
  ELSIF TG_TABLE_NAME = 'contact' THEN
    NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, '')), 'A');
  ELSE
    NEW.search_vector := setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE OF first_name, last_name, company ON "lead"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE OF first_name, last_name ON "contact"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE OF name ON "account"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE OF name ON "opportunity"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE OF name ON "campaign"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
-- Tenant-leading GIN (btree_gin), per the §3.5 index rule; search never returns deleted records.
CREATE INDEX "lead_search" ON "lead" USING gin ("tenant_id", "search_vector") WHERE "deleted_at" IS NULL;
CREATE INDEX "account_search" ON "account" USING gin ("tenant_id", "search_vector") WHERE "deleted_at" IS NULL;
CREATE INDEX "contact_search" ON "contact" USING gin ("tenant_id", "search_vector") WHERE "deleted_at" IS NULL;
CREATE INDEX "opportunity_search" ON "opportunity" USING gin ("tenant_id", "search_vector") WHERE "deleted_at" IS NULL;
CREATE INDEX "campaign_search" ON "campaign" USING gin ("tenant_id", "search_vector") WHERE "deleted_at" IS NULL;

-- Sharing (§6.4): every object's shares have their own partition (created in 0010 for the
-- standard objects; this keeps it true if that list ever changes).
SELECT record_share_ensure_partition(o)
FROM unnest(ARRAY['lead', 'account', 'contact', 'opportunity', 'campaign']) AS o;

SELECT enable_tenant_rls('lead');
SELECT enable_tenant_rls('account');
SELECT enable_tenant_rls('contact');
SELECT enable_tenant_rls('opportunity');
SELECT enable_tenant_rls('campaign');
SELECT enable_tenant_rls('pipeline');
SELECT enable_tenant_rls('pipeline_stage');
SELECT enable_tenant_rls('account_contact_relation');
SELECT enable_tenant_rls('opportunity_contact_role');
SELECT enable_tenant_rls('opportunity_stage_history');
SELECT enable_tenant_rls('campaign_member');
SELECT enable_tenant_rls('lead_conversion');
