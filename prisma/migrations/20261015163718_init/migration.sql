-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('REDDIT', 'TELEGRAM', 'WEB', 'X', 'FORUM', 'JOB_BOARD', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadCategory" AS ENUM ('WEBSITE', 'WEB_APP', 'MOBILE_APP', 'WORDPRESS', 'WOOCOMMERCE', 'SHOPIFY', 'TELEGRAM_BOT', 'DISCORD_BOT', 'CRM', 'AUTOMATION', 'AI', 'API_INTEGRATION', 'SEO', 'PERFORMANCE', 'BUG_FIX', 'REDESIGN', 'E_COMMERCE', 'LANDING_PAGE', 'CUSTOM_SOFTWARE', 'OTHER');

-- CreateEnum
CREATE TYPE "Temperature" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'REVIEWED', 'CONTACTED', 'REPLIED', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AnalysisStage" AS ENUM ('SCREEN', 'FULL', 'RESPONSE');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('DISCOVERED', 'DEDUPLICATED', 'ANALYZED', 'SCORED', 'REVIEWED', 'CONTACTED', 'REPLIED', 'STATUS_CHANGED', 'FOLLOWUP_SCHEDULED', 'NOTE');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('REDDIT', 'TELEGRAM', 'EMAIL', 'WEB_FORM', 'OTHER');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENT', 'DISCARDED');

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_scan_at" TIMESTAMP(3),
    "health" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_queries" (
    "id" TEXT NOT NULL,
    "source_id" TEXT,
    "query" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "variants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_run_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_external_id" TEXT,
    "source_url" TEXT,
    "source_author" TEXT,
    "source_created_at" TIMESTAMP(3),
    "title" TEXT,
    "original_content" TEXT NOT NULL,
    "category" "LeadCategory" NOT NULL DEFAULT 'OTHER',
    "project_description" TEXT,
    "intent_score" INTEGER NOT NULL DEFAULT 0,
    "lead_score" INTEGER NOT NULL DEFAULT 0,
    "temperature" "Temperature" NOT NULL DEFAULT 'COLD',
    "budget_min" INTEGER,
    "budget_max" INTEGER,
    "budget_currency" TEXT,
    "urgency" "Urgency" NOT NULL DEFAULT 'UNKNOWN',
    "location" TEXT,
    "business_type" TEXT,
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pain_points" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiAnalysis" JSONB,
    "ai_model" TEXT,
    "ai_processed_at" TIMESTAMP(3),
    "analysis_status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "content_hash" TEXT NOT NULL,
    "duplicate_of_id" TEXT,
    "score_breakdown" JSONB,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "stage" "AnalysisStage" NOT NULL DEFAULT 'FULL',
    "raw" JSONB,
    "parsed" JSONB,
    "usage" JSONB,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "channel" "OutreachChannel" NOT NULL DEFAULT 'OTHER',
    "body" TEXT NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "model" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "body" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "developer_profiles" (
    "id" TEXT NOT NULL DEFAULT 'owner',
    "name" TEXT NOT NULL DEFAULT 'Developer',
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experience" TEXT,
    "location" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minimum_budget" INTEGER,
    "portfolio" JSONB NOT NULL DEFAULT '[]',
    "tone" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "sent_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sources_kind_idx" ON "sources"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "sources_adapter_name_key" ON "sources"("adapter", "name");

-- CreateIndex
CREATE INDEX "search_queries_enabled_idx" ON "search_queries"("enabled");

-- CreateIndex
CREATE INDEX "leads_content_hash_idx" ON "leads"("content_hash");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_temperature_idx" ON "leads"("temperature");

-- CreateIndex
CREATE INDEX "leads_lead_score_idx" ON "leads"("lead_score");

-- CreateIndex
CREATE INDEX "leads_category_idx" ON "leads"("category");

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_source_id_source_external_id_key" ON "leads"("source_id", "source_external_id");

-- CreateIndex
CREATE INDEX "ai_analyses_lead_id_idx" ON "ai_analyses"("lead_id");

-- CreateIndex
CREATE INDEX "ai_analyses_created_at_idx" ON "ai_analyses"("created_at");

-- CreateIndex
CREATE INDEX "lead_events_lead_id_created_at_idx" ON "lead_events"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "outreach_lead_id_idx" ON "outreach"("lead_id");

-- CreateIndex
CREATE INDEX "outreach_status_idx" ON "outreach"("status");

-- CreateIndex
CREATE INDEX "follow_ups_due_at_done_idx" ON "follow_ups"("due_at", "done");

-- CreateIndex
CREATE INDEX "notifications_read_at_idx" ON "notifications"("read_at");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- AddForeignKey
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
