-- Lead conversion support (P02 T13). Additive.
-- AlterTable
ALTER TABLE "lead_conversion" ADD COLUMN     "record_versions" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "lead_field_mapping" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "lead_field" TEXT NOT NULL,
    "target_object" TEXT NOT NULL,
    "target_field" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "lead_field_mapping_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_field_mapping_tenant_id_target_object_target_field_key" ON "lead_field_mapping"("tenant_id", "target_object", "target_field");


ALTER TABLE "lead_field_mapping"
  ADD CONSTRAINT "lead_field_mapping_target_object"
    CHECK ("target_object" IN ('account', 'contact', 'opportunity')),
  ADD CONSTRAINT "lead_field_mapping_names"
    CHECK ("lead_field" ~ '^[a-z][a-z0-9_]{0,62}$' AND "target_field" ~ '^[a-z][a-z0-9_]{0,62}$');

SELECT enable_tenant_rls('lead_field_mapping');
