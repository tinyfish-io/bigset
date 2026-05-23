/** Schema inference keeps the higher-quality default. */
export const SCHEMA_INFERENCE_OPENROUTER_MODEL_ID = "anthropic/claude-sonnet-4-6";

/** Populate, structured recovery, and other non-inference LLM tasks. */
export const DEFAULT_OPENROUTER_MODEL_ID =
  process.env.OPENROUTER_POPULATE_MODEL ??
  process.env.OPENROUTER_MODEL ??
  "google/gemini-3.1-flash-lite";

export function requiredOpenRouterApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
  }
  return apiKey;
}
