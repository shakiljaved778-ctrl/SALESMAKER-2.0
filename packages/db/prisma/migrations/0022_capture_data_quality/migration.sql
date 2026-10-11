-- 0022_capture_data_quality — P03 T01: API keys, imports, web forms, email-to-lead, matching and
-- duplicate rules, duplicate jobs and review candidates; merge links and duplicate-matching keys
-- on lead, contact and account. Additive (expand-only).

-- CreateEnum
CREATE TYPE "api_key_environment" AS ENUM ('LIVE', 'TEST');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('UPLOADED', 'READY', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNDOING', 'UNDONE');

-- CreateEnum
CREATE TYPE "duplicate_mode" AS ENUM ('SKIP', 'UPDATE', 'CREATE');

-- CreateEnum
CREATE TYPE "import_row_status" AS ENUM ('CREATED', 'UPDATED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "capture_status" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "submission_status" AS ENUM ('RECEIVED', 'CREATED', 'DUPLICATE', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "inbound_email_status" AS ENUM ('RECEIVED', 'CREATED', 'MATCHED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "duplicate_action" AS ENUM ('BLOCK', 'ALERT');

-- CreateEnum
CREATE TYPE "duplicate_candidate_status" AS ENUM ('OPEN', 'DISMISSED', 'MERGED');

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "match_company_key" TEXT,
ADD COLUMN     "match_domain" TEXT,
ADD COLUMN     "match_phone" TEXT,
ADD COLUMN     "merged_into_id" UUID;

-- AlterTable
ALTER TABLE "contact" ADD COLUMN     "match_email" TEXT,
ADD COLUMN     "match_email_domain" TEXT,
ADD COLUMN     "match_mobile" TEXT,
ADD COLUMN     "match_name_key" TEXT,
ADD COLUMN     "match_phone" TEXT,
ADD COLUMN     "merged_into_id" UUID;

-- AlterTable
ALTER TABLE "lead" ADD COLUMN     "match_company_key" TEXT,
ADD COLUMN     "match_email" TEXT,
ADD COLUMN     "match_email_domain" TEXT,
ADD COLUMN     "match_mobile" TEXT,
ADD COLUMN     "match_name_key" TEXT,
ADD COLUMN     "match_phone" TEXT,
ADD COLUMN     "merged_into_id" UUID;

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "derived_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "api_key" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "environment" "api_key_environment" NOT NULL DEFAULT 'LIVE',
    "secret_hash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "run_as_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "rotated_from_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'UPLOADED',
    "file_name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_size" BIGINT NOT NULL,
    "file_type" TEXT NOT NULL,
    "sheet" TEXT,
    "header_row" INTEGER NOT NULL DEFAULT 1,
    "headers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "duplicate_mode" "duplicate_mode" NOT NULL DEFAULT 'SKIP',
    "matching_rule_id" UUID,
    "run_assignment" BOOLEAN NOT NULL DEFAULT false,
    "assignment_rule_id" UUID,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "dry_run" JSONB,
    "total" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "result_file_key" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "undone_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "import_row_result" (
    "tenant_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "import_row_status" NOT NULL,
    "record_id" UUID,
    "errors" JSONB,

    CONSTRAINT "import_row_result_pkey" PRIMARY KEY ("tenant_id","import_job_id","row_number")
);

-- CreateTable
CREATE TABLE "import_mapping_template" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headers_signature" TEXT NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "import_mapping_template_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "web_form" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "object" TEXT NOT NULL DEFAULT 'lead',
    "status" "capture_status" NOT NULL DEFAULT 'DRAFT',
    "run_as_user_id" UUID NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "assignment_rule_id" UUID,
    "auto_responder" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "web_form_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "web_form_field" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "form_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "default_value" JSONB,
    "values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "web_form_field_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "web_form_submission" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "form_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "submission_status" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "record_id" UUID,
    "reason" TEXT,

    CONSTRAINT "web_form_submission_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "inbound_email_address" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "capture_status" NOT NULL DEFAULT 'ACTIVE',
    "run_as_user_id" UUID NOT NULL,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "assignment_rule_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "inbound_email_address_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "inbound_email" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "address_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_id" TEXT,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "subject" TEXT,
    "raw_key" TEXT NOT NULL,
    "status" "inbound_email_status" NOT NULL DEFAULT 'RECEIVED',
    "record_object" TEXT,
    "record_id" UUID,
    "reason" TEXT,

    CONSTRAINT "inbound_email_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "matching_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "match_blank" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "matching_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "duplicate_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matching_rule_id" UUID NOT NULL,
    "action" "duplicate_action" NOT NULL DEFAULT 'ALERT',
    "on_create" BOOLEAN NOT NULL DEFAULT true,
    "on_edit" BOOLEAN NOT NULL DEFAULT true,
    "bypass_profile_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "duplicate_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "duplicate_job" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "matching_rule_id" UUID NOT NULL,
    "schedule" TEXT,
    "status" "job_run_status" NOT NULL DEFAULT 'QUEUED',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "found" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "duplicate_job_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "duplicate_candidate" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object" TEXT NOT NULL,
    "job_id" UUID,
    "record_ids" UUID[],
    "group_key" TEXT NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "status" "duplicate_candidate_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,

    CONSTRAINT "duplicate_candidate_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "api_key_tenant_id_run_as_user_id_idx" ON "api_key"("tenant_id", "run_as_user_id");

-- CreateIndex
CREATE INDEX "import_job_tenant_id_created_by_created_at_idx" ON "import_job"("tenant_id", "created_by", "created_at");

-- CreateIndex
CREATE INDEX "import_job_tenant_id_status_idx" ON "import_job"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "import_row_result_tenant_id_import_job_id_status_idx" ON "import_row_result"("tenant_id", "import_job_id", "status");

-- CreateIndex
CREATE INDEX "import_mapping_template_tenant_id_object_headers_signature_idx" ON "import_mapping_template"("tenant_id", "object", "headers_signature");

-- CreateIndex
CREATE UNIQUE INDEX "import_mapping_template_tenant_id_object_name_key" ON "import_mapping_template"("tenant_id", "object", "name");

-- CreateIndex
CREATE UNIQUE INDEX "web_form_field_tenant_id_form_id_field_key" ON "web_form_field"("tenant_id", "form_id", "field");

-- CreateIndex
CREATE INDEX "web_form_submission_tenant_id_form_id_received_at_idx" ON "web_form_submission"("tenant_id", "form_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_email_address_tenant_id_token_key" ON "inbound_email_address"("tenant_id", "token");

-- CreateIndex
CREATE INDEX "inbound_email_tenant_id_record_object_record_id_idx" ON "inbound_email"("tenant_id", "record_object", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_email_tenant_id_message_id_key" ON "inbound_email"("tenant_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "matching_rule_tenant_id_object_name_key" ON "matching_rule"("tenant_id", "object", "name");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_rule_tenant_id_object_name_key" ON "duplicate_rule"("tenant_id", "object", "name");

-- CreateIndex
CREATE INDEX "duplicate_job_tenant_id_next_run_at_idx" ON "duplicate_job"("tenant_id", "next_run_at");

-- CreateIndex
CREATE INDEX "duplicate_candidate_tenant_id_object_status_score_idx" ON "duplicate_candidate"("tenant_id", "object", "status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_candidate_tenant_id_object_group_key_key" ON "duplicate_candidate"("tenant_id", "object", "group_key");

-- CreateIndex
CREATE INDEX "account_tenant_id_match_company_key_idx" ON "account"("tenant_id", "match_company_key");

-- CreateIndex
CREATE INDEX "account_tenant_id_match_phone_idx" ON "account"("tenant_id", "match_phone");

-- CreateIndex
CREATE INDEX "account_tenant_id_match_domain_idx" ON "account"("tenant_id", "match_domain");

-- CreateIndex
CREATE INDEX "contact_tenant_id_match_email_idx" ON "contact"("tenant_id", "match_email");

-- CreateIndex
CREATE INDEX "contact_tenant_id_match_email_domain_idx" ON "contact"("tenant_id", "match_email_domain");

-- CreateIndex
CREATE INDEX "contact_tenant_id_match_phone_idx" ON "contact"("tenant_id", "match_phone");

-- CreateIndex
CREATE INDEX "contact_tenant_id_match_mobile_idx" ON "contact"("tenant_id", "match_mobile");

-- CreateIndex
CREATE INDEX "contact_tenant_id_match_name_key_idx" ON "contact"("tenant_id", "match_name_key");

-- CreateIndex
CREATE INDEX "lead_tenant_id_match_email_idx" ON "lead"("tenant_id", "match_email");

-- CreateIndex
CREATE INDEX "lead_tenant_id_match_email_domain_idx" ON "lead"("tenant_id", "match_email_domain");

-- CreateIndex
CREATE INDEX "lead_tenant_id_match_phone_idx" ON "lead"("tenant_id", "match_phone");

-- CreateIndex
CREATE INDEX "lead_tenant_id_match_mobile_idx" ON "lead"("tenant_id", "match_mobile");

-- CreateIndex
CREATE INDEX "lead_tenant_id_match_name_key_idx" ON "lead"("tenant_id", "match_name_key");

-- CreateIndex
CREATE INDEX "lead_tenant_id_match_company_key_idx" ON "lead"("tenant_id", "match_company_key");

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_run_as_user_id_fkey" FOREIGN KEY ("tenant_id", "run_as_user_id") REFERENCES "user"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_result" ADD CONSTRAINT "import_row_result_tenant_id_import_job_id_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "import_job"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_form" ADD CONSTRAINT "web_form_tenant_id_run_as_user_id_fkey" FOREIGN KEY ("tenant_id", "run_as_user_id") REFERENCES "user"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_form_field" ADD CONSTRAINT "web_form_field_tenant_id_form_id_fkey" FOREIGN KEY ("tenant_id", "form_id") REFERENCES "web_form"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_form_submission" ADD CONSTRAINT "web_form_submission_tenant_id_form_id_fkey" FOREIGN KEY ("tenant_id", "form_id") REFERENCES "web_form"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_email_address" ADD CONSTRAINT "inbound_email_address_tenant_id_run_as_user_id_fkey" FOREIGN KEY ("tenant_id", "run_as_user_id") REFERENCES "user"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_email" ADD CONSTRAINT "inbound_email_tenant_id_address_id_fkey" FOREIGN KEY ("tenant_id", "address_id") REFERENCES "inbound_email_address"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_rule" ADD CONSTRAINT "duplicate_rule_tenant_id_matching_rule_id_fkey" FOREIGN KEY ("tenant_id", "matching_rule_id") REFERENCES "matching_rule"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Duplicate-matching keys (§7.2) ──────────────────────────────────────────────────────────
-- Candidates are found by equality on these keys (btree indexes, usable under RLS), then scored
-- by the matching rule. All functions are immutable so the keys can be indexed and recomputed.

-- A company name without case, punctuation, a leading "the" or trailing legal forms
-- ("Gulf Trading W.L.L." and "gulf trading" give the same key).
CREATE OR REPLACE FUNCTION crm_company_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    lower(coalesce(name, '')),
    '\.', '', 'g'),                                   -- w.l.l. → wll, s.a. → sa
    '&', ' ', 'g'),
    '[^[:alnum:]]+', ' ', 'g'),                       -- punctuation and spacing
    '^the ', ''),
    '( (llc|ltd|limited|inc|incorporated|corp|corporation|co|company|plc|llp|lp|pvt|private|pte|pty|wll|fz|fze|fzc|fzco|gmbh|ag|kg|sa|sas|sarl|srl|spa|bv|nv|ab|oy|as|kk|holding|holdings|group|and))+$', ''
  )), '')
$$;

-- The last eight digits of a phone number (Qatar and Bahrain numbers have eight): the same number
-- written with or without its country code, trunk prefix, spaces or punctuation gives the same
-- key. Rules compare full numbers after this narrows the candidates.
CREATE OR REPLACE FUNCTION crm_phone_key(phone text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN length(d) >= 7 THEN right(d, 8) END
    FROM (SELECT regexp_replace(coalesce(phone, ''), '\D', '', 'g') AS d) p
$$;

CREATE OR REPLACE FUNCTION crm_email_key(email text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(lower(btrim(coalesce(email, ''))), '')
$$;

CREATE OR REPLACE FUNCTION crm_email_domain(email text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(split_part(crm_email_key(email), '@', 2), '')
$$;

-- How a surname sounds (Double Metaphone): "Haddad", "Hadad" and "Hadded" share a key.
CREATE OR REPLACE FUNCTION crm_name_key(last_name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(extensions.dmetaphone(btrim(coalesce(last_name, ''))), '')
$$;

-- A website's host without scheme, "www." or path.
CREATE OR REPLACE FUNCTION crm_domain_key(website text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(regexp_replace(regexp_replace(lower(btrim(coalesce(website, ''))),
    '^[a-z]+://', ''), '^www\.|[/?#:].*$', '', 'g'), '')
$$;

CREATE OR REPLACE FUNCTION crm_match_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lead' THEN
    NEW.match_email := crm_email_key(NEW.email);
    NEW.match_email_domain := crm_email_domain(NEW.email);
    NEW.match_phone := crm_phone_key(NEW.phone);
    NEW.match_mobile := crm_phone_key(NEW.mobile_phone);
    NEW.match_name_key := crm_name_key(NEW.last_name);
    NEW.match_company_key := crm_company_key(NEW.company);
  ELSIF TG_TABLE_NAME = 'contact' THEN
    NEW.match_email := crm_email_key(NEW.email);
    NEW.match_email_domain := crm_email_domain(NEW.email);
    NEW.match_phone := crm_phone_key(NEW.phone);
    NEW.match_mobile := crm_phone_key(NEW.mobile_phone);
    NEW.match_name_key := crm_name_key(NEW.last_name);
  ELSIF TG_TABLE_NAME = 'account' THEN
    NEW.match_company_key := crm_company_key(NEW.name);
    NEW.match_phone := crm_phone_key(NEW.phone);
    NEW.match_domain := crm_domain_key(NEW.website);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER crm_match_keys BEFORE INSERT OR UPDATE OF email, phone, mobile_phone, last_name, company
  ON "lead" FOR EACH ROW EXECUTE FUNCTION crm_match_keys();
CREATE TRIGGER crm_match_keys BEFORE INSERT OR UPDATE OF email, phone, mobile_phone, last_name
  ON "contact" FOR EACH ROW EXECUTE FUNCTION crm_match_keys();
CREATE TRIGGER crm_match_keys BEFORE INSERT OR UPDATE OF name, phone, website
  ON "account" FOR EACH ROW EXECUTE FUNCTION crm_match_keys();

-- Existing rows get their keys from the worker's derived-column backfill, per tenant: under forced
-- RLS this migration cannot see tenant rows (tenant_settings.derived_version gates the job).

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_object" CHECK ("object" IN ('lead', 'contact', 'account'));
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_counts"
  CHECK ("processed" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "skipped" >= 0 AND "failed" >= 0);
ALTER TABLE "import_row_result" ADD CONSTRAINT "import_row_result_row" CHECK ("row_number" > 0);
ALTER TABLE "web_form" ADD CONSTRAINT "web_form_object" CHECK ("object" = 'lead');
ALTER TABLE "matching_rule" ADD CONSTRAINT "matching_rule_object" CHECK ("object" IN ('lead', 'contact', 'account'));
ALTER TABLE "duplicate_rule" ADD CONSTRAINT "duplicate_rule_object" CHECK ("object" IN ('lead', 'contact', 'account'));
ALTER TABLE "duplicate_rule" ADD CONSTRAINT "duplicate_rule_when" CHECK ("on_create" OR "on_edit");
ALTER TABLE "duplicate_job" ADD CONSTRAINT "duplicate_job_schedule" CHECK ("schedule" IS NULL OR "schedule" IN ('daily', 'weekly'));
ALTER TABLE "duplicate_candidate" ADD CONSTRAINT "duplicate_candidate_size"
  CHECK (cardinality("record_ids") BETWEEN 2 AND 3);
ALTER TABLE "duplicate_candidate" ADD CONSTRAINT "duplicate_candidate_score" CHECK ("score" BETWEEN 0 AND 1);
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_hint" CHECK (length("hint") = 4);

-- ── Row-level security on every new table ───────────────────────────────────────────────────
SELECT enable_tenant_rls('api_key');
SELECT enable_tenant_rls('import_job');
SELECT enable_tenant_rls('import_row_result');
SELECT enable_tenant_rls('import_mapping_template');
SELECT enable_tenant_rls('web_form');
SELECT enable_tenant_rls('web_form_field');
SELECT enable_tenant_rls('web_form_submission');
SELECT enable_tenant_rls('inbound_email_address');
SELECT enable_tenant_rls('inbound_email');
SELECT enable_tenant_rls('matching_rule');
SELECT enable_tenant_rls('duplicate_rule');
SELECT enable_tenant_rls('duplicate_job');
SELECT enable_tenant_rls('duplicate_candidate');
