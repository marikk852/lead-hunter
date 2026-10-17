/**
 * OpenAI-compatible provider — the free path.
 *
 * One adapter, many vendors: anything that speaks `POST /chat/completions` with
 * an API key works here, which covers the free tiers this project targets:
 *
 *   Google AI Studio (default)  https://generativelanguage.googleapis.com/v1beta/openai
 *   Groq                        https://api.groq.com/openai/v1
 *   OpenRouter                  https://openrouter.ai/api/v1
 *   Mistral                     https://api.mistral.ai/v1
 *   Ollama (local, no key)      http://127.0.0.1:11434/v1
 *
 * Design notes, mirroring the Anthropic provider:
 *  - Structured output is requested from the API *and* re-validated locally with
 *    the same Zod schema, so a malformed response can never reach the database
 *    (README Rule 9). If a vendor rejects the strict JSON-schema request, the
 *    provider degrades (schema → json_object → plain) and records that in the
 *    run notes instead of failing the lead.
 *  - Prompt caching on these vendors is prefix-based and automatic (no
 *    `cache_control` markers exist in this API), so the frozen system prompt is
 *    simply sent unchanged and the prefix size is recorded in the notes.
 *  - No vendor SDK is imported: a plain `fetch` keeps this adapter dependency-free
 *    and testable through an injected `fetch`.
 */
import { z } from "zod";
import {
  LeadAnalysisSchema,
  ScreenResultSchema,
  type LeadAnalysis,
  type LeadPromptInput,
} from "@/src/ai/schemas";
import {
  ANALYSIS_SYSTEM_PROMPT,
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
  type ResponseInput,
  type ResponseOutcome,
  type ScreenOutcome,
  type TokenUsage,
} from "@/src/ai/types";
import { logger } from "@/src/lib/logger";

/** Google AI Studio free tier. Any OpenAI-compatible base URL can replace it. */
export const DEFAULT_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
/** Strong tier: analysis + response drafting. Free-priced on AI Studio. */
export const DEFAULT_COMPAT_MODEL = "gemini-3.8-flash";
/** Cheap tier: first-stage screening. */
export const DEFAULT_COMPAT_MODEL_FAST = "gemini-3.5-flash-lite";

const PROVIDER_NAME = "openai-compatible";

/** Minimal `fetch` surface, so tests can inject a stub. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type CompatProviderConfig = {
  apiKey: string;
  /** Base URL *without* the trailing `/chat/completions`. */
  baseUrl?: string;
  model?: string;
  fastModel?: string;
  /** Pinned model ids make the settings screen honest about what will be called. */
  fetch?: FetchLike;
  /** Extra headers (e.g. OpenRouter's `HTTP-Referer`). */
  headers?: Record<string, string>;
  /** Milliseconds before a call is abandoned. */
  timeoutMs?: number;
  /**
   * Extra attempts for *transient* failures only (429/502/503/504 and a dropped
   * connection). Free tiers spike load constantly, and a single 503 would
   * otherwise cost a lead's analysis. 0 disables retrying.
   */
  maxRetries?: number;
  /** Test seam so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Which shape of structured-output request to send. Vendors differ: Groq and
 * OpenAI honour `json_schema` strictly, several gateways only accept
 * `json_object`, and a local Ollama build may accept neither.
 */
export type StructuredMode = "json_schema" | "json_object" | "plain";

/** Ordered from strictest to most permissive; we only ever degrade. */
export const STRUCTURED_MODES: readonly StructuredMode[] = ["json_schema", "json_object", "plain"];

/**
 * JSON Schema for strict structured output.
 *
 * Strict mode (OpenAI, Groq) requires every object to set
 * `additionalProperties: false` and to list *all* of its properties as required
 * — a subset is rejected. Zod's schemas here are already total (no optional
 * keys), so this only has to add the flag and complete `required`.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  return normalizeNode(json);
}

function normalizeNode(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeNode(item)) as unknown as Record<string, unknown>;
  }
  if (typeof node !== "object" || node === null) return node as Record<string, unknown>;

  const record = { ...(node as Record<string, unknown>) };

  // `$ref` nodes are resolved by the receiver; rewriting them would break them.
  if (typeof record.$ref === "string") return record;

  // Note: Zod already emits `additionalProperties: false` and completes
  // `required` for the schemas in this project. This normalizer keeps the strict
  // contract true if a future schema shape (a record, a union) omits them.

  if (record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    for (const key of Object.keys(properties)) properties[key] = normalizeNode(properties[key]);
    record.additionalProperties = false;
    const existing = Array.isArray(record.required) ? (record.required as string[]) : [];
    const all = Object.keys(properties);
    record.required = [...new Set([...existing, ...all])];
  }

  for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf"] as const) {
    const value = record[key];
    if (Array.isArray(value)) {
      record[key] = value.map((item) => normalizeNode(item));
    } else if (value && typeof value === "object") {
      record[key] = normalizeNode(value);
    }
  }

  return record;
}

type ChatChoice = {
  message?: {
    content?: string | Array<{ type?: string; text?: string }> | null;
    refusal?: string | null;
  };
  finish_reason?: string;
};

type ChatResponse = {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string } | string;
};

function mapUsage(usage: ChatResponse["usage"]): TokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    // Vendors report cache hits in different places; accept both spellings.
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    // No vendor in this family bills a separate cache-write step.
    cacheCreationInputTokens: 0,
  };
}

/** Joins the content of a message, which may arrive as parts rather than a string. */
export function readContent(choice: ChatChoice | undefined): string {
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * Extracts a JSON value from a model answer. Models sometimes wrap the object
 * in a fenced block despite the schema; anything else is left to fail loudly.
 */
export function parseJsonAnswer(raw: string): unknown {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw new Error("no JSON object found in the model answer");
  }
}

/** Worth another attempt: the vendor did not serve the request. */
function isTransient(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Exponential backoff, capped so a slow vendor cannot stall a whole hunt. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}

function messageOf(body: ChatResponse): string {
  const error = body.error;
  if (typeof error === "string") return error;
  return error?.message ?? "";
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = PROVIDER_NAME;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fastModel: string;
  private readonly doFetch: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: CompatProviderConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_COMPAT_BASE_URL).replace(/\/+$/, "");
    this.model = config.model?.trim() || DEFAULT_COMPAT_MODEL;
    this.fastModel = config.fastModel?.trim() || DEFAULT_COMPAT_MODEL_FAST;
    this.doFetch = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...config.headers,
    };
  }

  /** Recorded per run so the settings screen and the audit trail agree. */
  describe() {
    return { provider: this.name, model: this.model, fastModel: this.fastModel, baseUrl: this.baseUrl };
  }

  /**
   * Caching on this API family is prefix-based and automatic, so there is nothing
   * to mark — but the prefix still has to be stable, and its size is worth seeing.
   */
  private prefixNote(systemPrompt: string, model: string): string[] {
    const estimated = estimateTokens(systemPrompt);
    return [
      `system prefix ≈${estimated} tokens for ${model}; vendor-side automatic prefix caching (no cache markers)`,
    ];
  }

  private async call(
    body: Record<string, unknown>,
    jsonSchema: Record<string, unknown> | null,
    mode: StructuredMode,
  ): Promise<{ response: ChatResponse; text: string; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ ...body, ...responseFormat(jsonSchema, mode) }),
        signal: controller.signal,
      });

      const text = await result.text();
      let parsed: ChatResponse = {};
      try {
        parsed = text.length > 0 ? (JSON.parse(text) as ChatResponse) : {};
      } catch {
        // Non-JSON body (an HTML error page from a proxy, say) — keep the text
        // so the error message can show what actually came back.
        parsed = {};
      }

      return { response: parsed, text, status: result.status };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends one request with two independent mechanisms:
   *
   *  - **retry** for transient failures (429/502/503/504, or a dropped
   *    connection), because free tiers spike and a single 503 should not cost a
   *    lead's analysis. Retrying never risks double spending: a 5xx means the
   *    vendor did not serve the request.
   *  - **degrade** for the structured-output shape (400/422), because only a
   *    looser body can fix that — auth and server errors are never masked by it.
   *
   * When no schema is supplied (a plain-text draft) there is nothing to degrade,
   * so the shape is fixed and only retries apply.
   */
  private async requestWithFallback(
    schema: z.ZodType | null,
    body: Record<string, unknown>,
    notes: string[],
  ): Promise<{ response: ChatResponse; status: number }> {
    const jsonSchema = schema ? strictJsonSchema(schema) : null;
    const modes: StructuredMode[] = schema ? [...STRUCTURED_MODES] : ["plain"];

    let last: { response: ChatResponse; text: string; status: number } | null = null;

    for (const [index, mode] of modes.entries()) {
      let used = 0;
      let attempt: { response: ChatResponse; text: string; status: number } | null = null;

      for (;;) {
        try {
          attempt = await this.call(body, jsonSchema, mode);
        } catch (error) {
          // Transport failure: a timeout or a dropped connection. The request may
          // or may not have been processed, but a 5xx/abort is the only case a
          // provider reports like this, so retry rather than lose the item.
          if (used < this.maxRetries) {
            used += 1;
            logger.warn("transport failure; retrying", {
              provider: this.name,
              mode,
              attempt: used,
              error: error instanceof Error ? error.message : String(error),
            });
            await this.sleep(backoffMs(used));
            continue;
          }
          throw new AIProviderError(
            `${this.name} request failed after ${used + 1} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`,
            this.name,
            error,
          );
        }

        used += 1;

        if (attempt.status >= 200 && attempt.status < 300) {
          if (index > 0) {
            notes.push(`structured output degraded to "${mode}" after a ${last?.status} response`);
          }
          if (used > 1) notes.push(`recovered after ${used - 1} transient failure(s)`);
          return attempt;
        }

        last = attempt;
        const detail = messageOf(attempt.response) || attempt.text.slice(0, 300);
        const transient = isTransient(attempt.status);
        const shapeError = attempt.status === 400 || attempt.status === 422;

        // A transient failure keeps the same shape: it is a different problem
        // from the degradations below, and both loops must not mix.
        if (transient && used <= this.maxRetries) {
          logger.warn("transient provider error; retrying", {
            provider: this.name,
            mode,
            status: attempt.status,
            attempt: used,
            detail: detail.slice(0, 200),
          });
          await this.sleep(backoffMs(used));
          continue;
        }

        if (shapeError && index < modes.length - 1) {
          logger.warn("structured-output request rejected; retrying with a looser shape", {
            provider: this.name,
            mode,
            status: attempt.status,
            detail: detail.slice(0, 200),
          });
          break;
        }

        throw new AIProviderError(
          `${this.name} request failed (${attempt.status}, ${used} attempt${used === 1 ? "" : "s"}): ${detail}`,
          this.name,
        );
      }

    }

    // Only reachable when the shape kept degrading without ever failing hard.
    throw new AIProviderError(
      `${this.name} request failed: ${last?.text.slice(0, 300) ?? "no response"}`,
      this.name,
    );
  }

  async screen(lead: LeadPromptInput): Promise<ScreenOutcome> {
    const model = this.fastModel;
    const notes = this.prefixNote(SCREEN_SYSTEM_PROMPT, model);

    const { response } = await this.requestWithFallback(
      ScreenResultSchema,
      {
        model,
        max_tokens: 512,
        messages: [
          { role: "system", content: SCREEN_SYSTEM_PROMPT },
          { role: "user", content: buildScreenUserMessage(lead) },
        ],
      },
      notes,
    );

    const choice = response.choices?.[0];
    const raw = readContent(choice);
    if (raw.length === 0) {
      throw new AIProviderError(
        `screen: model returned no parseable output (${choice?.message?.refusal ? "refusal" : "empty"})`,
        this.name,
      );
    }

    return {
      screen: ScreenResultSchema.parse(parseJsonAnswer(raw)),
      provider: this.name,
      model,
      promptVersion: PROMPT_VERSION,
      usage: mapUsage(response.usage),
      raw,
      notes,
    };
  }

  async analyzeLead(lead: LeadPromptInput): Promise<AnalysisOutcome> {
    const model = this.model;
    const notes = this.prefixNote(ANALYSIS_SYSTEM_PROMPT, model);

    const { response } = await this.requestWithFallback(
      LeadAnalysisSchema,
      {
        model,
        max_tokens: 4096,
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: buildAnalysisUserMessage(lead) },
        ],
      },
      notes,
    );

    const choice = response.choices?.[0];
    const raw = readContent(choice);
    if (raw.length === 0) {
      throw new AIProviderError(
        `analyzeLead: model returned no output (${choice?.message?.refusal ? `refusal: ${choice.message.refusal}` : `finish_reason: ${choice?.finish_reason ?? "unknown"}`})`,
        this.name,
      );
    }

    let candidate: unknown;
    try {
      candidate = parseJsonAnswer(raw);
    } catch (error) {
      throw new AIProviderError(
        `analyzeLead: answer was not JSON (finish_reason: ${choice?.finish_reason ?? "unknown"}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.name,
      );
    }

    // Second gate: never trust the provider's own validation.
    const analysis: LeadAnalysis = LeadAnalysisSchema.parse(candidate);

    const usage = mapUsage(response.usage);
    if (usage && usage.cacheReadInputTokens > 0) {
      logger.info("prefix cache hit", { provider: this.name, model, cacheReadInputTokens: usage.cacheReadInputTokens });
    }

    return {
      analysis,
      provider: this.name,
      model,
      promptVersion: PROMPT_VERSION,
      usage,
      raw,
      notes,
    };
  }

  async generateResponse(input: ResponseInput): Promise<ResponseOutcome> {
    const model = this.model;
    const profileBlock = buildOwnerProfileBlock(input.profile);
    const notes = this.prefixNote(`${RESPONSE_SYSTEM_PROMPT}\n\n${profileBlock}`, model);

    const { response } = await this.requestWithFallback(
      // A draft is prose: there is no schema to enforce.
      null,
      {
        model,
        max_tokens: 2048,
        messages: [
          // Instructions first, the semi-static profile second: the shared prefix
          // stays identical between leads, which is what prefix caching keys on.
          { role: "system", content: RESPONSE_SYSTEM_PROMPT },
          { role: "system", content: profileBlock },
          {
            role: "user",
            content: buildResponseUserMessage({
              lead: input.lead,
              analysis: input.analysis,
              adjust: input.adjust,
            }),
          },
        ],
      },
      notes,
    );

    const body = readContent(response.choices?.[0]);
    if (body.length === 0) {
      throw new AIProviderError("generateResponse: model returned an empty message", this.name);
    }

    return {
      body,
      provider: this.name,
      model,
      promptVersion: PROMPT_VERSION,
      usage: mapUsage(response.usage),
      raw: body,
      notes,
    };
  }
}

/**
 * The `response_format` field for the chosen mode. Plain-text calls (a draft)
 * carry no schema, so they never send the field at all.
 */
function responseFormat(
  jsonSchema: Record<string, unknown> | null,
  mode: StructuredMode,
): Record<string, unknown> {
  if (mode === "plain" || jsonSchema === null) return {};

  if (mode === "json_object") return { response_format: { type: "json_object" } };

  return {
    response_format: {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: jsonSchema },
    },
  };
}
