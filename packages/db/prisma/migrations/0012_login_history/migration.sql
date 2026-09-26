-- 0012_login_history — P01 T12: every sign-in attempt and its outcome (§6.1, §6.7).
-- Additive (expand-only). Append-only: history is never edited.

-- CreateEnum
CREATE TYPE "login_method" AS ENUM ('password', 'google', 'microsoft', 'otp', 'recovery_code');

-- CreateEnum
CREATE TYPE "login_outcome" AS ENUM ('SUCCESS', 'MFA_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_CODE', 'LOCKED', 'EMAIL_NOT_VERIFIED', 'NO_ACCOUNT');

-- CreateTable
CREATE TABLE "login_history" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,
    "email_hash" BYTEA,
    "method" "login_method" NOT NULL,
    "outcome" "login_outcome" NOT NULL,
    "session_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "login_history_tenant_id_occurred_at_idx" ON "login_history"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "login_history_tenant_id_user_id_occurred_at_idx" ON "login_history"("tenant_id", "user_id", "occurred_at");


CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "login_history"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
REVOKE UPDATE, DELETE, TRUNCATE ON "login_history" FROM sm_app;
SELECT enable_tenant_rls('login_history');
