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
