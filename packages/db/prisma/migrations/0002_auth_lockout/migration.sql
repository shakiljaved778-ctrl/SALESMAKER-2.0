-- 0002_auth_lockout — P00 T10: remember when a lockout was imposed so backoff can double (§6.1).
-- Additive (expand-only): a nullable column on an existing table.
ALTER TABLE "auth_attempt" ADD COLUMN "locked_until" TIMESTAMPTZ(6);
