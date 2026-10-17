-- CreateTable
CREATE TABLE "ai_health_checks" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_health_checks_created_at_idx" ON "ai_health_checks"("created_at");
