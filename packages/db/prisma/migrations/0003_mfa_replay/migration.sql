-- 0003_mfa_replay — P00 T11: remember the last accepted TOTP time step so codes cannot be replayed.
-- Additive (expand-only).
ALTER TABLE "mfa_factor" ADD COLUMN "last_used_step" BIGINT;
