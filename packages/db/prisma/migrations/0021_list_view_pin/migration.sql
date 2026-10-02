-- P02 T19: a user's pinned default list view per object (§5.6). Additive (expand only).

-- CreateTable
CREATE TABLE "list_view_pin" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "list_view_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_view_pin_pkey" PRIMARY KEY ("tenant_id","user_id","object_id")
);

-- CreateIndex
CREATE INDEX "list_view_pin_tenant_id_list_view_id_idx" ON "list_view_pin"("tenant_id", "list_view_id");

-- AddForeignKey
ALTER TABLE "list_view_pin" ADD CONSTRAINT "list_view_pin_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_view_pin" ADD CONSTRAINT "list_view_pin_tenant_id_object_id_fkey" FOREIGN KEY ("tenant_id", "object_id") REFERENCES "object_definition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_view_pin" ADD CONSTRAINT "list_view_pin_tenant_id_list_view_id_fkey" FOREIGN KEY ("tenant_id", "list_view_id") REFERENCES "list_view"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


SELECT enable_tenant_rls('list_view_pin');
