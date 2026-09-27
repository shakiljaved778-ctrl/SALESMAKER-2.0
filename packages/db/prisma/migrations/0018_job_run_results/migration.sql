-- Mass-action outcomes on job_run (P02 T10). Additive.
-- AlterTable
ALTER TABLE "job_run" ADD COLUMN     "failed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "result" JSONB;

