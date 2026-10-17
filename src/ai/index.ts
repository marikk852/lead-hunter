/**
 * Provider selection + cost guard (README §26, §33).
 * This is the only module the rest of the app should import from `src/ai`.
 */
import { AnthropicProvider } from "@/src/ai/providers/anthropic";
import { HEURISTIC_MODEL, HeuristicProvider } from "@/src/ai/providers/heuristic";
import {
  DEFAULT_COMPAT_BASE_URL,
  DEFAULT_COMPAT_MODEL,
  DEFAULT_COMPAT_MODEL_FAST,
  OpenAICompatibleProvider,
} from "@/src/ai/providers/openai-compatible";
import type { AIProvider, AnalysisOutcome, ResponseInput, ResponseOutcome, ScreenOutcome } from "@/src/ai/types";
import type { LeadPromptInput } from "@/src/ai/schemas";
import { prisma } from "@/src/lib/db";
import {
  anthropicApiKey,
  compatApiKey,
  compatBaseUrl,
  env,
  hasAnthropicKey,
  hasCompatKey,
} from "@/src/lib/env";
import { logger } from "@/src/lib/logger";

/** Defaults for the Anthropic path, used when `AI_MODEL*` is unset. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";
export const DEFAULT_ANTHROPIC_MODEL_FAST = "claude-haiku-4-5";

export * from "@/src/ai/types";
export * from "@/src/ai/schemas";
export { heuristicAnalyze, heuristicResponse, HeuristicProvider } from "@/src/ai/providers/heuristic";

export class BudgetExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Daily AI call limit reached (${limit}). Raise AI_DAILY_CALL_LIMIT to continue.`);
    this.name = "BudgetExceededError";
  }
}

/** Counts billable provider calls made today. Rule-based runs are free and not counted. */
export async function callsUsedToday(now = new Date()): Promise<number> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  return prisma.aIAnalysis.count({
    where: { createdAt: { gte: startOfDay }, provider: { not: "heuristic" } },
  });
}

async function assertWithinBudget(): Promise<void> {
  const limit = env().AI_DAILY_CALL_LIMIT;
  const used = await callsUsedToday();
  if (used >= limit) {
    logger.warn("daily AI call limit reached", { used, limit });
    throw new BudgetExceededError(limit);
  }
}

/** Refuses to spend money once the configured daily ceiling is hit. */
class BudgetGuardProvider implements AIProvider {
  constructor(private readonly inner: AIProvider) {}

  get name() {
    return this.inner.name;
  }

  async screen(lead: LeadPromptInput): Promise<ScreenOutcome> {
    await assertWithinBudget();
    if (!this.inner.screen) throw new Error("provider does not implement screen");
    return this.inner.screen(lead);
  }

  async analyzeLead(lead: LeadPromptInput): Promise<AnalysisOutcome> {
    await assertWithinBudget();
    return this.inner.analyzeLead(lead);
  }

  async generateResponse(input: ResponseInput): Promise<ResponseOutcome> {
    await assertWithinBudget();
    return this.inner.generateResponse(input);
  }
}

/**
 * Why a provider was chosen. A code, not a sentence: the console renders it in
 * the owner's language (`settings.providerReasons`), the same way server-action
 * failures travel as codes.
 */
export type ProviderReason =
  | "aiApiKey"
  | "anthropicApiKey"
  | "openaiForced"
  | "anthropicForced"
  | "noKey"
  | "missingKey";

/** What the settings screen and the logs report about the active provider. */
export type ProviderInfo = {
  name: string;
  model: string;
  /** Cheap screening tier, used by `screen()` before a full analysis. */
  fastModel: string;
  /** True when a usable API key is configured for this provider. */
  keyed: boolean;
  /** True when a provider was requested but could not be used, so we fell back. */
  degraded: boolean;
  reason: ProviderReason;
  /** Which env name is missing, when `reason` is `missingKey`. */
  expectedKey: string | null;
};

type Resolved = { provider: AIProvider; info: ProviderInfo };

let cached: Resolved | null = null;

/**
 * Chooses the provider.
 *
 *  - `auto` (the default) prefers the free OpenAI-compatible provider, then
 *    Anthropic, then the keyless rules. Dropping in `AI_API_KEY` is therefore
 *    the whole switch — no second variable to remember.
 *  - an explicitly requested provider with no key falls back to the rules and
 *    says so, loudly, rather than pretending a model ran.
 */
function resolve(): Resolved {
  if (cached) return cached;

  const { AI_PROVIDER, AI_MODEL, AI_MODEL_FAST, AI_EFFORT } = env();

  const wantsCompat = AI_PROVIDER === "openai" || (AI_PROVIDER === "auto" && hasCompatKey());
  const wantsAnthropic =
    AI_PROVIDER === "anthropic" || (AI_PROVIDER === "auto" && !hasCompatKey() && hasAnthropicKey());

  if (AI_PROVIDER !== "heuristic" && wantsCompat && hasCompatKey()) {
    const provider = new OpenAICompatibleProvider({
      apiKey: compatApiKey() as string,
      baseUrl: compatBaseUrl() ?? DEFAULT_COMPAT_BASE_URL,
      model: AI_MODEL ?? DEFAULT_COMPAT_MODEL,
      fastModel: AI_MODEL_FAST ?? DEFAULT_COMPAT_MODEL_FAST,
    });
    const described = provider.describe();
    logger.info("AI provider ready", { provider: described.provider, model: described.model, baseUrl: described.baseUrl });
    cached = {
      provider: new BudgetGuardProvider(provider),
      info: {
        name: described.provider,
        model: described.model,
        fastModel: described.fastModel,
        keyed: true,
        degraded: false,
        reason: AI_PROVIDER === "auto" ? "aiApiKey" : "openaiForced",
        expectedKey: null,
      },
    };
    return cached;
  }

  if (AI_PROVIDER !== "heuristic" && wantsAnthropic && hasAnthropicKey()) {
    const model = AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    const fastModel = AI_MODEL_FAST ?? DEFAULT_ANTHROPIC_MODEL_FAST;
    logger.info("AI provider ready", { provider: "anthropic", model });
    cached = {
      provider: new BudgetGuardProvider(
        new AnthropicProvider({
          apiKey: anthropicApiKey() as string,
          model,
          fastModel,
          effort: AI_EFFORT,
        }),
      ),
      info: {
        name: "anthropic",
        model,
        fastModel,
        keyed: true,
        degraded: false,
        reason: AI_PROVIDER === "auto" ? "anthropicApiKey" : "anthropicForced",
        expectedKey: null,
      },
    };
    return cached;
  }

  // Explicit request without a key, or `auto` with no key at all.
  const requestedButKeyless =
    (AI_PROVIDER === "openai" && !hasCompatKey()) ||
    (AI_PROVIDER === "anthropic" && !hasAnthropicKey());

  if (requestedButKeyless) {
    logger.warn(
      `AI_PROVIDER=${AI_PROVIDER} but no API key is set — using the rule-based provider`,
      { expectedKey: AI_PROVIDER === "openai" ? "AI_API_KEY" : "ANTHROPIC_API_KEY" },
    );
  }

  cached = {
    provider: new HeuristicProvider(),
    info: {
      name: "heuristic",
      model: HEURISTIC_MODEL,
      fastModel: HEURISTIC_MODEL,
      keyed: false,
      degraded: requestedButKeyless,
      reason: requestedButKeyless ? "missingKey" : "noKey",
      expectedKey: requestedButKeyless
        ? AI_PROVIDER === "openai"
          ? "AI_API_KEY"
          : "ANTHROPIC_API_KEY"
        : null,
    },
  };
  return cached;
}

/** The provider the pipeline will use. */
export function getAIProvider(): AIProvider {
  return resolve().provider;
}

/** Which provider is active and why, for the settings screen. */
export function describeAIProvider(): ProviderInfo {
  return resolve().info;
}

/**
 * Drops the memoized selection so the next call re-reads the environment.
 * Settings calls this after writing a key into `.env`: without it the console
 * would keep running the provider that was chosen before the key existed.
 */
export function resetAIProviderCache(): void {
  cached = null;
}
