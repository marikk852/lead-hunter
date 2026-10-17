/**
 * Environment access. Validated once, with a clear failure message.
 * Secrets stay in `.env` — never in source (README §6 Rule 6, §34).
 */
import { z } from "zod";

/**
 * A blank value means "not configured". Without this, `AI_MODEL=""` would be a
 * configured-but-empty model name and the provider would be called with `""`.
 */
const optionalText = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional(),

  OWNER_PASSWORD: z.string().optional(),
  OWNER_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 chars"),
  APP_URL: z.string().default("http://localhost:3000"),

  /**
   * `auto` (default) picks the best configured provider: the free
   * OpenAI-compatible one when `AI_API_KEY` is set, else Anthropic, else the
   * keyless rule-based provider. The explicit values force one choice.
   */
  AI_PROVIDER: z.enum(["auto", "heuristic", "anthropic", "openai"]).default("auto"),
  ANTHROPIC_API_KEY: optionalText,
  /**
   * Provider-agnostic key (SPEC §12). Drives the OpenAI-compatible provider —
   * Google AI Studio, Groq, OpenRouter, Mistral, a local Ollama, anything that
   * speaks `/chat/completions`. Kept as the Anthropic fallback alias as well.
   */
  AI_API_KEY: optionalText,
  /** Override the OpenAI-compatible endpoint (defaults to Google AI Studio). */
  AI_BASE_URL: optionalText,
  /** Leave unset to use the selected provider's own default model. */
  AI_MODEL: optionalText,
  AI_MODEL_FAST: optionalText,
  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  AI_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(250),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OWNER_CHAT_ID: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().default("lead-hunter/0.1"),
  /** Point the adapter at a proxy, a mirror, or a local stub for testing. */
  REDDIT_BASE_URL: optionalText,
  REDDIT_OAUTH_URL: optionalText,
  REDIS_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }
  return parsed.data;
}

let cached: Env | null = null;

export function env(): Env {
  cached ??= load();
  return cached;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** True when a real LLM provider is configured; otherwise the pipeline uses heuristics. */
export function anthropicApiKey(): string | null {
  // `AI_API_KEY` stays accepted here so an existing Anthropic setup keeps working.
  return nonEmpty(process.env.ANTHROPIC_API_KEY) ?? nonEmpty(process.env.AI_API_KEY);
}

export function hasAnthropicKey(): boolean {
  return anthropicApiKey() !== null;
}

/** Key for the OpenAI-compatible provider — the free tier path. */
export function compatApiKey(): string | null {
  return nonEmpty(process.env.AI_API_KEY);
}

/** Base URL override for the OpenAI-compatible provider, if configured. */
export function compatBaseUrl(): string | null {
  return nonEmpty(process.env.AI_BASE_URL);
}

export function hasCompatKey(): boolean {
  return compatApiKey() !== null;
}
