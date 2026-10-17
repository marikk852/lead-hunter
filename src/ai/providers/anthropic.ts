/**
 * Anthropic Claude provider.
 *
 * Design notes:
 *  - Structured output is enforced by the API (`output_config.format` +
 *    `messages.parse`) AND re-validated locally with the same Zod schema, so a
 *    malformed response can never reach the database (README Rule 9).
 *  - Prompt caching: the frozen system prompt carries a `cache_control`
 *    breakpoint; all volatile data sits after it in `messages`.
 *  - Two model tiers (README §33): a cheap model screens, the strong model
 *    analyses and drafts the reply.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  LeadAnalysisSchema,
  ScreenResultSchema,
  type LeadAnalysis,
  type LeadPromptInput,
} from "@/src/ai/schemas";
import {
  ANALYSIS_SYSTEM_PROMPT,
  MIN_CACHEABLE_PREFIX_TOKENS,
  PROMPT_VERSION,
  RESPONSE_SYSTEM_PROMPT,
  SCREEN_SYSTEM_PROMPT,
  buildAnalysisUserMessage,
  buildOwnerProfileBlock,
  buildResponseUserMessage,
  buildScreenUserMessage,
  estimateTokens,
} from "@/src/ai/prompts";
import {
  AIProviderError,
  type AIProvider,
  type AnalysisOutcome,
  type KeyPing,
  type ResponseInput,
  type ResponseOutcome,
  type ScreenOutcome,
  type TokenUsage,
} from "@/src/ai/types";
import { logger } from "@/src/lib/logger";

/** `effort` is rejected by pre-4.6 Sonnet and Haiku 4.5. */
export function supportsEffort(model: string): boolean {
  return !/haiku-4-5|sonnet-4-5/.test(model);
}

/** Adaptive thinking exists on Opus 4.6+/Sonnet 4.6; older models need a token budget. */
export function supportsAdaptiveThinking(model: string): boolean {
  return /opus-4-(6|7)|sonnet-4-6/.test(model);
}

function mapUsage(usage: Anthropic.Usage | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export type AnthropicProviderConfig = {
  apiKey: string;
  /** Strong tier: full analysis and response drafting. */
  model: string;
  /** Cheap tier: first-stage screening. */
  fastModel: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Test seam: inject a client (or a stub) instead of constructing one.
   * Lets the request shape be asserted without network access.
   */
  client?: Pick<Anthropic, "messages">;
};

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";

  private readonly client: Pick<Anthropic, "messages">;
  private readonly config: AnthropicProviderConfig;
  private warnedAboutCachePrefix = false;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.client = config.client ?? new Anthropic({ apiKey: config.apiKey });
  }

  /**
   * Live key probe for the Settings monitor: one minimal four-token message.
   * Server-side errors (429/5xx) get a single retry after a short pause;
   * auth failures (401/403) are final on the first try.
   */
  async ping(): Promise<KeyPing> {
    const started = Date.now();
    let lastDetail = "no response";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.client.messages.create({
          model: this.config.model,
          max_tokens: 4,
          messages: [{ role: "user", content: "ping" }],
        });
        return { ok: true, detail: "ok", latencyMs: Date.now() - started };
      } catch (error) {
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status?: unknown }).status)
            : undefined;
        const message = error instanceof Error ? error.message : String(error);
        lastDetail = status ? `HTTP ${status}: ${message}` : message;
        const transient = status === 429 || status === undefined || status >= 500;
        if (!transient || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    return {
      ok: false,
      detail: lastDetail.slice(0, 300),
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Prompt-cache diagnostics. A prefix below the model's documented minimum
   * caches silently *not at all* — so say so out loud rather than assuming.
   */
  private notePrefixSize(systemPrompt: string, model: string): string[] {
    const estimated = estimateTokens(systemPrompt);
    if (estimated >= MIN_CACHEABLE_PREFIX_TOKENS) {
      return [`system prefix ≈${estimated} tokens, cacheable`];
    }
    if (!this.warnedAboutCachePrefix) {
      this.warnedAboutCachePrefix = true;
      logger.warn("prompt prefix is below the minimum cacheable size; caching is a no-op", {
        model,
        estimatedTokens: estimated,
        minimum: MIN_CACHEABLE_PREFIX_TOKENS,
      });
    }
    return [`system prefix ≈${estimated} tokens, below the ${MIN_CACHEABLE_PREFIX_TOKENS}-token cache minimum`];
  }

  async screen(lead: LeadPromptInput): Promise<ScreenOutcome> {
    const model = this.config.fastModel;
    const notes = this.notePrefixSize(SCREEN_SYSTEM_PROMPT, model);

    const message = await this.client.messages.parse({
      model,
      max_tokens: 512,
      // Frozen prefix + cache breakpoint; the post itself goes after it.
      system: [
        { type: "text", text: SCREEN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: buildScreenUserMessage(lead) }],
      output_config: { format: zodOutputFormat(ScreenResultSchema) },
    });

    if (!message.parsed_output) {
      throw new AIProviderError("screen: model returned no parseable output", this.name);
    }
    const screen = ScreenResultSchema.parse(message.parsed_output);

    return {
      screen,
      provider: this.name,
      model,
      promptVersion: PROMPT_VERSION,
      usage: mapUsage(message.usage),
      raw: message.parsed_output,
      notes,
    };
  }

  async analyzeLead(lead: LeadPromptInput): Promise<AnalysisOutcome> {
    const model = this.config.model;
    const notes = this.notePrefixSize(ANALYSIS_SYSTEM_PROMPT, model);

    const baseParams = {
      model,
      max_tokens: 4096,
      system: [
        { type: "text" as const, text: ANALYSIS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
      ],
      messages: [{ role: "user" as const, content: buildAnalysisUserMessage(lead) }],
      output_config: {
        format: zodOutputFormat(LeadAnalysisSchema),
        ...(supportsEffort(model) ? { effort: this.config.effort } : {}),
      },
    };

    const withThinking = supportsAdaptiveThinking(model);

    let message: Awaited<ReturnType<typeof this.client.messages.parse>>;
    try {
      message = await this.client.messages.parse({
        ...baseParams,
        ...(withThinking ? { thinking: { type: "adaptive" as const } } : {}),
      });
    } catch (error) {
      // A 400 usually means this model rejects one of the optional knobs
      // (e.g. adaptive thinking on a model that predates it). Degrade to the
      // minimal documented request rather than losing the lead.
      const status = (error as { status?: number } | null)?.status;
      if ((error instanceof Anthropic.BadRequestError || status === 400) && withThinking) {
        logger.warn("analysis request rejected; retrying without adaptive thinking", {
          model,
          status,
        });
        notes.push("retried without adaptive thinking after a 400 response");
        message = await this.client.messages.parse(baseParams);
      } else {
        throw new AIProviderError(
          `analyzeLead failed: ${error instanceof Error ? error.message : String(error)}`,
          this.name,
          error,
        );
      }
    }

    if (!message.parsed_output) {
      throw new AIProviderError(
        `analyzeLead: model returned no parseable output (stop_reason: ${message.stop_reason ?? "unknown"})`,
        this.name,
      );
    }

    // Second gate: never trust the provider's own validation.
    const analysis: LeadAnalysis = LeadAnalysisSchema.parse(message.parsed_output);

    const usage = mapUsage(message.usage);
    if (usage && usage.cacheReadInputTokens > 0 && !this.warnedAboutCachePrefix) {
      logger.info("prompt cache hit", {
        model,
        cacheReadInputTokens: usage.cacheReadInputTokens,
      });
    }

    return {
      analysis,
      provider: this.name,
      model,
      promptVersion: PROMPT_VERSION,
      usage,
      raw: message.parsed_output,
      notes,
    };
  }

  async generateResponse(input: ResponseInput): Promise<ResponseOutcome> {
    const model = this.config.model;
    const profileBlock = buildOwnerProfileBlock(input.profile);
    const notes = this.notePrefixSize(
      `${RESPONSE_SYSTEM_PROMPT}\n\n${profileBlock}`,
      model,
    );

    const message = await this.client.messages.create({
      model,
      max_tokens: 2048,
      // Instructions are frozen; the profile changes rarely and sits behind the
      // breakpoint, so the pair shares one cache entry.
      system: [
        { type: "text", text: RESPONSE_SYSTEM_PROMPT },
        { type: "text", text: profileBlock, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: buildResponseUserMessage({
            lead: input.lead,
            analysis: input.analysis,
            adjust: input.adjust,
          }),
        },
      ],
      ...(supportsEffort(model) ? { output_config: { effort: "medium" as const } } : {}),
    });

    const body = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (body.length === 0) {
      throw new AIProviderError("generateResponse: model returned an empty message", this.name);
    }

    return {
      body,
      provider: this.name,
      model,
      promptVersion: PROMPT_VERSION,
      usage: mapUsage(message.usage),
      raw: body,
      notes,
    };
  }
}
