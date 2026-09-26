-- 0013_invitations — P01 T13: user invitations (§6.1, P01 plan §3.4). Additive (expand-only).

-- CreateTable
CREATE TABLE "invitation" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "invited_by" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "invitation_tenant_id_user_id_idx" ON "invitation"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_tenant_id_token_hash_key" ON "invitation"("tenant_id", "token_hash");

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


SELECT enable_tenant_rls('invitation');
