-- 0015_metadata — P02 T01: object and field metadata, picklists, record types, layouts, path,
-- validation rules, auto-number formats and list views (§5). Additive (expand-only).

-- CreateEnum
CREATE TYPE "field_type" AS ENUM ('id', 'text', 'textarea', 'long_text', 'rich_text', 'email', 'phone', 'url', 'number', 'currency', 'percent', 'date', 'datetime', 'time', 'checkbox', 'picklist', 'multi_picklist', 'lookup', 'master_detail', 'auto_number', 'formula', 'rollup_summary', 'geolocation', 'user');

-- CreateEnum
CREATE TYPE "list_view_visibility" AS ENUM ('PRIVATE', 'GROUPS', 'ALL');

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "catalogue_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "object_definition" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "api_name" TEXT NOT NULL,
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "label_singular" TEXT,
    "label_plural" TEXT,
    "description" TEXT,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "record_number_prefix" TEXT NOT NULL,
    "name_field" TEXT NOT NULL,
    "features" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "object_definition_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "field_definition" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object_id" UUID NOT NULL,
    "api_name" TEXT NOT NULL,
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "type" "field_type" NOT NULL,
    "label" TEXT,
    "description" TEXT,
    "help_text" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "is_unique" BOOLEAN NOT NULL DEFAULT false,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "is_external_id" BOOLEAN NOT NULL DEFAULT false,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "indexed" BOOLEAN NOT NULL DEFAULT false,
    "track_history" BOOLEAN NOT NULL DEFAULT false,
    "length" INTEGER,
    "precision" INTEGER,
    "scale" INTEGER,
    "reference_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relationship_name" TEXT,
    "default_value" JSONB,
    "formula" TEXT,
    "formula_return_type" "field_type",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "field_definition_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "picklist_value" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "field_id" UUID NOT NULL,
    "api_value" TEXT NOT NULL,
    "label" TEXT,
    "category" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "picklist_value_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "record_type" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object_id" UUID NOT NULL,
    "api_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "pipeline_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "record_type_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "record_type_picklist" (
    "tenant_id" UUID NOT NULL,
    "record_type_id" UUID NOT NULL,
    "picklist_value_id" UUID NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "record_type_picklist_pkey" PRIMARY KEY ("tenant_id","record_type_id","picklist_value_id")
);

-- CreateTable
CREATE TABLE "page_layout" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "related_lists" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "page_layout_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "layout_assignment" (
    "tenant_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "record_type_id" UUID NOT NULL,
    "page_layout_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "layout_assignment_pkey" PRIMARY KEY ("tenant_id","profile_id","record_type_id")
);

-- CreateTable
CREATE TABLE "compact_layout" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "compact_layout_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "path_setting" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "record_type_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "path_setting_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "validation_rule" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object_id" UUID NOT NULL,
    "api_name" TEXT NOT NULL,
    "description" TEXT,
    "formula" TEXT NOT NULL,
    "error_message" TEXT NOT NULL,
    "error_field" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "validation_rule_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "auto_number_sequence" (
    "tenant_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "start_at" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_number_sequence_pkey" PRIMARY KEY ("tenant_id","field_id")
);

-- CreateTable
CREATE TABLE "list_view" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "object_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "system_key" TEXT,
    "owner_id" UUID,
    "visibility" "list_view_visibility" NOT NULL DEFAULT 'PRIVATE',
    "group_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "filter" JSONB,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "list_view_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "object_definition_tenant_id_api_name_key" ON "object_definition"("tenant_id", "api_name");

-- CreateIndex
CREATE UNIQUE INDEX "field_definition_tenant_id_object_id_api_name_key" ON "field_definition"("tenant_id", "object_id", "api_name");

-- CreateIndex
CREATE UNIQUE INDEX "picklist_value_tenant_id_field_id_api_value_key" ON "picklist_value"("tenant_id", "field_id", "api_value");

-- CreateIndex
CREATE UNIQUE INDEX "record_type_tenant_id_object_id_api_name_key" ON "record_type"("tenant_id", "object_id", "api_name");

-- CreateIndex
CREATE INDEX "record_type_picklist_tenant_id_picklist_value_id_idx" ON "record_type_picklist"("tenant_id", "picklist_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_layout_tenant_id_object_id_name_key" ON "page_layout"("tenant_id", "object_id", "name");

-- CreateIndex
CREATE INDEX "layout_assignment_tenant_id_page_layout_id_idx" ON "layout_assignment"("tenant_id", "page_layout_id");

-- CreateIndex
CREATE INDEX "layout_assignment_tenant_id_object_id_idx" ON "layout_assignment"("tenant_id", "object_id");

-- CreateIndex
CREATE UNIQUE INDEX "compact_layout_tenant_id_object_id_name_key" ON "compact_layout"("tenant_id", "object_id", "name");

-- CreateIndex
CREATE INDEX "path_setting_tenant_id_field_id_idx" ON "path_setting"("tenant_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "path_setting_tenant_id_record_type_id_field_id_key" ON "path_setting"("tenant_id", "record_type_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "validation_rule_tenant_id_object_id_api_name_key" ON "validation_rule"("tenant_id", "object_id", "api_name");

-- CreateIndex
CREATE INDEX "list_view_tenant_id_object_id_owner_id_idx" ON "list_view"("tenant_id", "object_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "list_view_tenant_id_object_id_system_key_key" ON "list_view"("tenant_id", "object_id", "system_key");

-- AddForeignKey
ALTER TABLE "field_definition" ADD CONSTRAINT "field_definition_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picklist_value" ADD CONSTRAINT "picklist_value_tenant_id_field_id_fkey" FOREIGN KEY ("tenant_id", "field_id") REFERENCES "field_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_type" ADD CONSTRAINT "record_type_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_type_picklist" ADD CONSTRAINT "record_type_picklist_tenant_id_record_type_id_fkey" FOREIGN KEY ("tenant_id", "record_type_id") REFERENCES "record_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_type_picklist" ADD CONSTRAINT "record_type_picklist_tenant_id_picklist_value_id_fkey" FOREIGN KEY ("tenant_id", "picklist_value_id") REFERENCES "picklist_value"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_layout" ADD CONSTRAINT "page_layout_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_assignment" ADD CONSTRAINT "layout_assignment_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_assignment" ADD CONSTRAINT "layout_assignment_tenant_id_profile_id_fkey" FOREIGN KEY ("tenant_id", "profile_id") REFERENCES "profile"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_assignment" ADD CONSTRAINT "layout_assignment_tenant_id_record_type_id_fkey" FOREIGN KEY ("tenant_id", "record_type_id") REFERENCES "record_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_assignment" ADD CONSTRAINT "layout_assignment_tenant_id_page_layout_id_fkey" FOREIGN KEY ("tenant_id", "page_layout_id") REFERENCES "page_layout"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compact_layout" ADD CONSTRAINT "compact_layout_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "path_setting" ADD CONSTRAINT "path_setting_tenant_id_record_type_id_fkey" FOREIGN KEY ("tenant_id", "record_type_id") REFERENCES "record_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "path_setting" ADD CONSTRAINT "path_setting_tenant_id_field_id_fkey" FOREIGN KEY ("tenant_id", "field_id") REFERENCES "field_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_rule" ADD CONSTRAINT "validation_rule_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_number_sequence" ADD CONSTRAINT "auto_number_sequence_tenant_id_field_id_fkey" FOREIGN KEY ("tenant_id", "field_id") REFERENCES "field_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_view" ADD CONSTRAINT "list_view_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_view" ADD CONSTRAINT "list_view_tenant_id_owner_id_fkey" FOREIGN KEY ("tenant_id", "owner_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "object_definition" ADD CONSTRAINT "object_definition_api_name"
  CHECK ("api_name" ~ '^[a-z][a-z0-9_]{0,38}$');
ALTER TABLE "field_definition" ADD CONSTRAINT "field_definition_api_name"
  CHECK ("api_name" ~ '^[a-z][a-z0-9_]{0,38}$');
-- Custom fields end in __c; standard fields never do.
ALTER TABLE "field_definition" ADD CONSTRAINT "field_definition_custom_suffix"
  CHECK ("is_standard" = ("api_name" !~ '__c$'));
ALTER TABLE "record_type" ADD CONSTRAINT "record_type_api_name"
  CHECK ("api_name" ~ '^[a-z][a-z0-9_]{0,38}$');
ALTER TABLE "validation_rule" ADD CONSTRAINT "validation_rule_api_name"
  CHECK ("api_name" ~ '^[a-z][a-z0-9_]{0,38}$');
ALTER TABLE "compact_layout" ADD CONSTRAINT "compact_layout_fields"
  CHECK (cardinality("fields") BETWEEN 1 AND 7);
ALTER TABLE "auto_number_sequence" ADD CONSTRAINT "auto_number_sequence_format"
  CHECK ("format" ~ '^[^{}]*\{0+\}[^{}]*$' AND "start_at" >= 1);
-- One default layout, compact layout and record type per object.
CREATE UNIQUE INDEX "page_layout_one_default" ON "page_layout" ("tenant_id", "object_id") WHERE "is_default";
CREATE UNIQUE INDEX "compact_layout_one_default" ON "compact_layout" ("tenant_id", "object_id") WHERE "is_default";
CREATE UNIQUE INDEX "record_type_one_default" ON "record_type" ("tenant_id", "object_id") WHERE "is_default";

-- At most 60 tracked fields per object (§7.17).
CREATE OR REPLACE FUNCTION check_tracked_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM field_definition
      WHERE tenant_id = NEW.tenant_id AND object_id = NEW.object_id AND track_history
        AND deleted_at IS NULL) > 60 THEN
    RAISE EXCEPTION 'at most 60 tracked fields per object' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER check_tracked_fields AFTER INSERT OR UPDATE OF "track_history" ON "field_definition"
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.track_history) EXECUTE FUNCTION check_tracked_fields();

-- ── Auto numbers ────────────────────────────────────────────────────────────────────────────
-- Each auto-number field draws from its own sequence, created on first use (like audit_next_seq),
-- so concurrent creates never wait on a counter row. Gaps are possible, as in Salesforce.
CREATE OR REPLACE FUNCTION auto_number_next(p_field uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  t uuid := app_current_tenant_id();
  start_value bigint;
  seq_name text;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'auto_number_next needs a tenant transaction';
  END IF;
  SELECT start_at INTO start_value FROM auto_number_sequence WHERE tenant_id = t AND field_id = p_field;
  IF start_value IS NULL THEN
    RAISE EXCEPTION 'no auto-number format for field %', p_field;
  END IF;
  seq_name := 'autonum_' || md5(t::text || ':' || p_field::text);
  IF to_regclass(format('public.%I', seq_name)) IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('autonum:' || seq_name, 0));
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I AS bigint MINVALUE 1 START %s',
      seq_name, start_value);
  END IF;
  RETURN nextval(format('public.%I', seq_name)::regclass);
END
$$;
REVOKE ALL ON FUNCTION auto_number_next(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auto_number_next(uuid) TO sm_app;

-- ── metadata_version ────────────────────────────────────────────────────────────────────────
-- The metadata cache is keyed by tenant_settings.metadata_version (§3.10, §5.6). Every change
-- bumps it in the same transaction. List views are user data, not metadata, and do not bump it.
CREATE OR REPLACE FUNCTION bump_metadata_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenant_settings SET metadata_version = metadata_version + 1
  WHERE tenant_id = app_current_tenant_id();
  RETURN NULL;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['object_definition', 'field_definition', 'picklist_value', 'record_type',
    'record_type_picklist', 'page_layout', 'layout_assignment', 'compact_layout', 'path_setting',
    'validation_rule', 'auto_number_sequence']
  LOOP
    EXECUTE format('CREATE TRIGGER bump_metadata_version AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH STATEMENT EXECUTE FUNCTION bump_metadata_version()', t);
  END LOOP;
END
$$;

SELECT enable_tenant_rls('object_definition');
SELECT enable_tenant_rls('field_definition');
SELECT enable_tenant_rls('picklist_value');
SELECT enable_tenant_rls('record_type');
SELECT enable_tenant_rls('record_type_picklist');
SELECT enable_tenant_rls('page_layout');
SELECT enable_tenant_rls('layout_assignment');
SELECT enable_tenant_rls('compact_layout');
SELECT enable_tenant_rls('path_setting');
SELECT enable_tenant_rls('validation_rule');
SELECT enable_tenant_rls('auto_number_sequence');
SELECT enable_tenant_rls('list_view');
