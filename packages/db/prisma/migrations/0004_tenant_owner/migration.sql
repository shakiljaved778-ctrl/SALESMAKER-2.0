-- 0004_tenant_owner — P00 T13: signup owner and activation time. Additive (expand-only).
ALTER TABLE "tenant_settings" ADD COLUMN "owner_user_id" UUID;
ALTER TABLE "tenant_settings" ADD COLUMN "activated_at" TIMESTAMPTZ(6);
