-- CreateEnum
CREATE TYPE "ScanRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanSourceStatus" AS ENUM ('OK', 'EMPTY', 'ERROR', 'SKIPPED');

-- AlterEnum
ALTER TYPE "SourceKind" ADD VALUE 'PERPLEXITY';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "search_query_id" TEXT;

-- CreateTable
CREATE TABLE "scan_runs" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "status" "ScanRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "queries_run" INTEGER NOT NULL DEFAULT 0,
    "discovered" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "stopped" TEXT,
    "error" TEXT,
    "summary" JSONB,

    CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_source_results" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "query_id" TEXT,
    "query" TEXT NOT NULL,
    "status" "ScanSourceStatus" NOT NULL,
    "items" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_source_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_locks" (
    "id" TEXT NOT NULL,
    "locked_by" TEXT NOT NULL,
    "locked_until" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_runs_started_at_idx" ON "scan_runs"("started_at");

-- CreateIndex
CREATE INDEX "scan_runs_status_idx" ON "scan_runs"("status");

-- CreateIndex
CREATE INDEX "scan_source_results_run_id_idx" ON "scan_source_results"("run_id");

-- CreateIndex
CREATE INDEX "leads_search_query_id_idx" ON "leads"("search_query_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_search_query_id_fkey" FOREIGN KEY ("search_query_id") REFERENCES "search_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_source_results" ADD CONSTRAINT "scan_source_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "scan_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_source_results" ADD CONSTRAINT "scan_source_results_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "search_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
