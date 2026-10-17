/**
 * The provider-agnostic AI contract (README §26).
 * Nothing outside `src/ai` may import a vendor SDK directly.
 */
import type {
  LeadAnalysis,
  LeadPromptInput,
  OwnerProfileFacts,
  ScreenResult,
} from "@/src/ai/schemas";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache (~0.1x price). */
  cacheReadInputTokens: number;
  /** Tokens written to the prompt cache (~1.25x price). */
  cacheCreationInputTokens: number;
};

export type CallMeta = {
  provider: string;
  model: string;
  promptVersion: string;
  usage: TokenUsage | null;
  /** Raw provider payload, stored for auditing. */
  raw: unknown;
  /** Non-fatal notes, e.g. a retry with a degraded request shape. */
  notes: string[];
};

export type ScreenOutcome = CallMeta & { screen: ScreenResult };
export type AnalysisOutcome = CallMeta & { analysis: LeadAnalysis };
export type ResponseOutcome = CallMeta & { body: string };

/**
 * Result of a live key probe (Settings → key health): one minimal request that
 * proves the configured key still authenticates and the endpoint answers.
 * `detail` is deliberate English log-style text — it carries the vendor's own
 * message verbatim, the same way `lead_events` lines do.
 */
export type KeyPing = {
  ok: boolean;
  detail: string;
  latencyMs: number;
};

export type ResponseInput = {
  lead: LeadPromptInput;
  analysis: LeadAnalysis;
  profile: OwnerProfileFacts;
  /** Owner instruction used to revise a previous draft. */
  adjust?: string | null;
};

export interface AIProvider {
  readonly name: string;
  /** Cheap first-stage filter. Optional: providers may skip straight to analysis. */
  screen?(lead: LeadPromptInput): Promise<ScreenOutcome>;
  analyzeLead(lead: LeadPromptInput): Promise<AnalysisOutcome>;
  generateResponse(input: ResponseInput): Promise<ResponseOutcome>;
  /**
   * Live authentication probe for the key monitor. Absent on keyless providers:
   * there is nothing to test, and the monitor reports "not configured" instead.
   * Probes are tiny one-token requests; the daily analysis budget does not count
   * them, so checking a key can never fail because the budget is spent.
   */
  ping?(): Promise<KeyPing>;
}

/** Raised when a provider cannot produce a schema-valid result. */
export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
