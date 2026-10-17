/**
 * Read model for the dashboard (README §19-§21).
 * All filtering happens in SQL so the UI can stay a thin server component.
 */
import type { LeadCategory, LeadStatus, SourceKind, Temperature, Urgency } from "@/src/generated/prisma/enums";
import { prisma } from "@/src/lib/db";

export type LeadFilters = {
  q?: string;
  sourceKind?: SourceKind;
  category?: LeadCategory;
  temperature?: Temperature;
  status?: LeadStatus;
  /** Several statuses at once (dashboard shows open opportunities). */
  statuses?: LeadStatus[];
  urgency?: Urgency;
  minScore?: number;
  minBudget?: number;
  location?: string;
  createdAfter?: Date;
  page?: number;
  pageSize?: number;
};

export const DEFAULT_PAGE_SIZE = 25;

function buildWhere(filters: LeadFilters) {
  const where: Record<string, unknown> = {};

  if (filters.q) {
    const query = filters.q.trim();
    where.OR = [
      { originalContent: { contains: query, mode: "insensitive" } },
      { title: { contains: query, mode: "insensitive" } },
      { projectDescription: { contains: query, mode: "insensitive" } },
      { sourceAuthor: { contains: query, mode: "insensitive" } },
    ];
  }

  if (filters.sourceKind) where.source = { kind: filters.sourceKind };
  if (filters.category) where.category = filters.category;
  if (filters.temperature) where.temperature = filters.temperature;
  if (filters.status) where.status = filters.status;
  else if (filters.statuses && filters.statuses.length > 0) where.status = { in: filters.statuses };
  if (filters.urgency) where.urgency = filters.urgency;
  if (typeof filters.minScore === "number") where.leadScore = { gte: filters.minScore };
  if (typeof filters.minBudget === "number") where.budgetMax = { gte: filters.minBudget };
  if (filters.location) where.location = { contains: filters.location, mode: "insensitive" };
  if (filters.createdAfter) where.createdAt = { gte: filters.createdAfter };

  return where;
}

export async function listLeads(filters: LeadFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));
  const where = buildWhere(filters);

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: [{ leadScore: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        source: { select: { kind: true, name: true, adapter: true } },
        _count: { select: { events: true, outreach: true } },
      },
    }),
  ]);

  return { leads, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getLeadDetail(id: string) {
  return prisma.lead.findUnique({
    where: { id },
    include: {
      source: true,
      events: { orderBy: { createdAt: "desc" } },
      analyses: { orderBy: { createdAt: "desc" }, take: 5 },
      outreach: { orderBy: { createdAt: "desc" } },
      followUps: { orderBy: { dueAt: "asc" } },
      duplicates: { select: { id: true, sourceUrl: true, originalContent: true } },
    },
  });
}

export type DashboardStats = {
  hot: number;
  warm: number;
  cold: number;
  contacted: number;
  replied: number;
  qualified: number;
  won: number;
  newToday: number;
  failed: number;
  needsReview: number;
  potentialRevenueMin: number;
  potentialRevenueMax: number;
  currency: string | null;
};

export async function getDashboardStats(now: Date = new Date()): Promise<DashboardStats> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [temps, statuses, newToday, failed, openValue, currencyRow, pendingReview] = await Promise.all([
    prisma.lead.groupBy({ by: ["temperature"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.lead.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.lead.count({ where: { analysisStatus: "FAILED" } }),
    prisma.lead.aggregate({
      where: {
        status: { in: ["NEW", "REVIEWED"] },
        leadScore: { gte: 50 },
      },
      _sum: { budgetMin: true, budgetMax: true },
    }),
    prisma.lead.findFirst({
      where: { budgetCurrency: { not: null }, status: { in: ["NEW", "REVIEWED"] } },
      select: { budgetCurrency: true },
      orderBy: { leadScore: "desc" },
    }),
    prisma.lead.count({ where: { status: "NEW" } }),
  ]);

  const byTemperature = Object.fromEntries(temps.map((row) => [row.temperature, row._count._all]));
  const byStatus = Object.fromEntries(statuses.map((row) => [row.status, row._count._all]));

  return {
    hot: byTemperature.HOT ?? 0,
    warm: byTemperature.WARM ?? 0,
    cold: byTemperature.COLD ?? 0,
    contacted: byStatus.CONTACTED ?? 0,
    replied: byStatus.REPLIED ?? 0,
    qualified: byStatus.QUALIFIED ?? 0,
    won: byStatus.WON ?? 0,
    newToday,
    failed,
    needsReview: pendingReview,
    potentialRevenueMin: openValue._sum.budgetMin ?? 0,
    potentialRevenueMax: openValue._sum.budgetMax ?? 0,
    currency: currencyRow?.budgetCurrency ?? null,
  };
}

/** Distinct values used to populate filter dropdowns. */
export async function getFilterOptions() {
  const [categories, statuses, temperatures, urgencies, locations] = await Promise.all([
    prisma.lead.groupBy({ by: ["category"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["temperature"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["urgency"], _count: { _all: true } }),
    prisma.lead.findMany({
      where: { location: { not: null } },
      select: { location: true },
      distinct: ["location"],
      orderBy: { location: "asc" },
      take: 25,
    }),
  ]);

  return {
    categories: categories.map((row) => row.category).sort(),
    statuses: statuses.map((row) => row.status),
    temperatures: temperatures.map((row) => row.temperature),
    urgencies: urgencies.map((row) => row.urgency),
    locations: locations.flatMap((row) => (row.location ? [row.location] : [])),
  };
}

/** Due or overdue follow-ups, for the dashboard banner (README §18). */
export async function getDueFollowUps(now: Date = new Date()) {
  return prisma.followUp.findMany({
    where: { done: false, dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
    take: 10,
    include: {
      lead: { select: { id: true, title: true, leadScore: true, sourceUrl: true } },
    },
  });
}
