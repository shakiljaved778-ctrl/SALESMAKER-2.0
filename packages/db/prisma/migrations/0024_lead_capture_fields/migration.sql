-- 0024_lead_capture_fields — P03 T03: catalogue v3 lead fields. Capture: source detail, how the
-- lead arrived, UTM parameters, referrer, landing page and ad click ids (§7.1). Scoring: fit,
-- engagement, combined score and grade, written by the primary scoring model (§7.4).
-- Additive (expand-only).

-- AlterTable
ALTER TABLE "lead" ADD COLUMN     "captured_via" TEXT,
ADD COLUMN     "engagement_score" INTEGER,
ADD COLUMN     "fbclid" TEXT,
ADD COLUMN     "fit_score" INTEGER,
ADD COLUMN     "gclid" TEXT,
ADD COLUMN     "grade" TEXT,
ADD COLUMN     "landing_page" TEXT,
ADD COLUMN     "lead_source_detail" TEXT,
ADD COLUMN     "referrer" TEXT,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "utm_campaign" TEXT,
ADD COLUMN     "utm_content" TEXT,
ADD COLUMN     "utm_medium" TEXT,
ADD COLUMN     "utm_source" TEXT,
ADD COLUMN     "utm_term" TEXT;

-- CreateIndex
CREATE INDEX "lead_tenant_id_score_id_idx" ON "lead"("tenant_id", "score", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_score_id_idx" ON "lead"("tenant_id", "owner_id", "score", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_grade_id_idx" ON "lead"("tenant_id", "grade", "id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_id_grade_id_idx" ON "lead"("tenant_id", "owner_id", "grade", "id");


-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "lead" ADD CONSTRAINT "lead_scores" CHECK (
  ("fit_score" IS NULL OR "fit_score" BETWEEN 0 AND 100) AND
  ("engagement_score" IS NULL OR "engagement_score" BETWEEN 0 AND 100) AND
  ("score" IS NULL OR "score" BETWEEN 0 AND 100));
