/**
 * Backend configuration for AI models.
 *
 * Defines the typed interfaces and constants for model management.
 */

import { api, internal, convex } from "../convex.js";
import { env } from "../env.js";
import { getLlmProviderConfig, requireOpenRouterApiKey } from "../local-credentials.js";
import { FETCH_TIMEOUT_MS } from "../fetch-timeout.js";
import {
  defaultBaseUrlForLlmProvider,
  defaultModelForLlmProviderRole,
  modelsUrlForLlmProvider,
  type ModelRoleKey,
} from "./llm.js";

export interface OpenRouterModel {
  modelName: string;
  canonicalSlug: string;
  contextLength: number;
  completionCost: number;
  promptCost: number;
}

/**
 * Default model identifiers for each agent role.
 * Read from environment variables so operators can change production defaults
 * without touching code. Local mode falls back to the selected LLM provider's
 * default model first.
 */
export const DEFAULT_MODEL_IDS = {
  SCHEMA_INFERENCE: env.SCHEMA_INFERENCE_MODEL,
  POPULATE_ORCHESTRATOR: env.POPULATE_ORCHESTRATOR_MODEL,
  INVESTIGATE_SUBAGENT: env.INVESTIGATE_SUBAGENT_MODEL,
} as const;

const OPENAI_MODEL_EXCLUDE_PATTERNS = [
  "audio",
  "babbage",
  "dall-e",
  "davinci",
  "embedding",
  "image",
  "instruct",
  "moderation",
  "realtime",
  "sora",
  "transcribe",
  "tts",
  "whisper",
];

const GOOGLE_MODEL_EXCLUDE_PATTERNS = [
  "audio",
  "embedding",
  "imagen",
  "image",
  "live",
  "lyria",
  "nano-banana",
  "robotics",
  "tts",
  "veo",
];

const TEXT_MODEL_EXCLUDE_PATTERNS = [
  "audio",
  "babbage",
  "dall-e",
  "embedding",
  "image",
  "moderation",
  "rerank",
  "safeguard",
  "sdxl",
  "speech",
  "stable-diffusion",
  "transcribe",
  "tts",
  "video",
  "voice",
  "wan",
  "whisper",
];

const QWEN_MODELS: OpenRouterModel[] = [
  {
    modelName: "qwen-plus",
    canonicalSlug: "qwen-plus",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen3.5-plus",
    canonicalSlug: "qwen3.5-plus",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen3-max",
    canonicalSlug: "qwen3-max",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen-max",
    canonicalSlug: "qwen-max",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen-flash",
    canonicalSlug: "qwen-flash",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen3-235b-a22b-instruct-2507",
    canonicalSlug: "qwen3-235b-a22b-instruct-2507",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen3-235b-a22b-thinking-2507",
    canonicalSlug: "qwen3-235b-a22b-thinking-2507",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
  {
    modelName: "qwen3-coder-plus",
    canonicalSlug: "qwen3-coder-plus",
    contextLength: 0,
    completionCost: 0,
    promptCost: 0,
  },
];

function isOpenAITextModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (OPENAI_MODEL_EXCLUDE_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return false;
  }
  return (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("chatgpt-")
  );
}

function isGenericTextModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !TEXT_MODEL_EXCLUDE_PATTERNS.some((pattern) =>
    lower.includes(pattern),
  );
}

function isGoogleTextModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (GOOGLE_MODEL_EXCLUDE_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return false;
  }
  return (
    lower.startsWith("gemini-") ||
    lower.startsWith("gemma-") ||
    lower.startsWith("deep-research-")
  );
}

function isMistralTextModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    isGenericTextModelId(id) &&
    (lower.startsWith("mistral-") ||
      lower.startsWith("magistral-") ||
      lower.startsWith("ministral-") ||
      lower.startsWith("codestral-") ||
      lower.startsWith("devstral-") ||
      lower.startsWith("pixtral-"))
  );
}

function isProviderTextModelId(
  id: string,
  provider: Awaited<ReturnType<typeof getLlmProviderConfig>>,
): boolean {
  if (!provider) return true;
  switch (provider.provider) {
    case "openrouter":
      return id.includes("/");
    case "openai":
      return isOpenAITextModelId(id) && !id.includes("/");
    case "anthropic":
      return id.startsWith("claude-") && !id.includes("/");
    case "google":
      return isGoogleTextModelId(id) && !id.includes("/");
    case "xai":
      return id.startsWith("grok-") && !id.includes("imagine");
    case "deepseek":
      return id.startsWith("deepseek-");
    case "qwen":
      return id.startsWith("qwen") || id.startsWith("qwq-");
    case "mistral":
      return isMistralTextModelId(id);
    case "groq":
    case "togetherai":
    case "deepinfra":
    case "fireworks":
    case "huggingface":
      return isGenericTextModelId(id);
    case "ollama":
    case "lmstudio":
    case "custom":
      return true;
  }
}

function googleModelIdFromName(name: string): string {
  return name.replace(/^models\//, "");
}

function sortModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return models.sort((a, b) => a.modelName.localeCompare(b.modelName));
}

function isModelCompatibleWithProvider(
  modelId: string | undefined,
  provider: Awaited<ReturnType<typeof getLlmProviderConfig>>,
): modelId is string {
  if (!modelId) return false;
  return isProviderTextModelId(modelId, provider);
}

function modelForProvider(
  savedModel: string | undefined,
  role: ModelRoleKey,
  envDefault: string,
  provider: Awaited<ReturnType<typeof getLlmProviderConfig>>,
): string {
  if (isModelCompatibleWithProvider(savedModel, provider)) return savedModel;
  if (provider?.provider) return defaultModelForLlmProviderRole(provider.provider, role);
  return envDefault;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Model list request failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Model roles for the settings UI.
 */
export const MODEL_ROLES = [
  { key: "schemaInference", label: "Schema Inference" },
  { key: "populateOrchestrator", label: "Populate Orchestrator" },
  { key: "investigateSubagent", label: "Investigate Subagent" },
] as const;

/**
 * Models explicitly excluded from the list.
 * These are models that we exclude from the OpenRouter fetch results
 * based on known incompatibilities or undesirability for our use case.
 */
export const EXCLUDED_MODEL_SLUGS: string[] = [];

/**
 * Fetch all cached models from Convex.
 * If the cache is empty, fetches from OpenRouter, stores in Convex, and returns.
 */
export async function getCachedModels(): Promise<OpenRouterModel[]> {
  const models = await convex.query(api.openRouterModels.list, {});
  const cached = models as unknown as OpenRouterModel[];
  if (cached.length > 0) return cached;

  const fetched = await fetchModelsFromOpenRouter();
  await upsertModelBatch(fetched);
  return fetched;
}

export async function fetchModelsForCurrentLlmProvider(): Promise<OpenRouterModel[]> {
  const config = await getLlmProviderConfig();
  if (!config) {
    throw new Error("LLM provider is not configured.");
  }

  if (config.provider === "openrouter") {
    return await getCachedModels();
  }

  if (config.provider === "anthropic") {
    const baseUrl = (config.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const json = await fetchJsonWithTimeout<{
      data?: Array<{
        id: string;
        display_name?: string;
        max_input_tokens?: number;
      }>;
    }>(`${baseUrl}/models?limit=100`, {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    });

    return sortModels(
      (json.data ?? []).map((model) => ({
        modelName: model.display_name ?? model.id,
        canonicalSlug: model.id,
        contextLength: model.max_input_tokens ?? 0,
        completionCost: 0,
        promptCost: 0,
      })),
    );
  }

  if (config.provider === "google") {
    const baseUrl = (
      config.baseUrl ||
      defaultBaseUrlForLlmProvider("google") ||
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
    const json = await fetchJsonWithTimeout<{
      models?: Array<{
        name: string;
        baseModelId?: string;
        displayName?: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedActions?: string[];
        supportedGenerationMethods?: string[];
      }>;
    }>(`${baseUrl}/models`, {
      "x-goog-api-key": config.apiKey,
    });

    return sortModels(
      (json.models ?? [])
        .map((model) => {
          const modelId = model.baseModelId || googleModelIdFromName(model.name);
          return {
            model,
            modelId,
            actions:
              model.supportedActions ?? model.supportedGenerationMethods ?? [],
          };
        })
        .filter(({ modelId, actions }) => {
          return (
            isGoogleTextModelId(modelId) &&
            (actions.length === 0 || actions.includes("generateContent"))
          );
        })
        .map(({ model, modelId }) => ({
          modelName: model.displayName ?? modelId,
          canonicalSlug: modelId,
          contextLength: model.inputTokenLimit ?? 0,
          completionCost: 0,
          promptCost: 0,
        })),
    );
  }

  if (config.provider === "qwen") {
    return sortModels([...QWEN_MODELS]);
  }

  const baseUrl = (
    config.baseUrl ||
    defaultBaseUrlForLlmProvider(config.provider) ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const headers: Record<string, string> =
    ["custom", "ollama", "lmstudio"].includes(config.provider) && !config.apiKey
      ? {}
      : { Authorization: `Bearer ${config.apiKey}` };
  const json = await fetchJsonWithTimeout<{
    data?: Array<{
      id: string;
      display_name?: string;
      name?: string;
      context_length?: number;
      contextLength?: number;
    }>;
  }>(modelsUrlForLlmProvider(config.provider, baseUrl), headers);

  const models = (json.data ?? [])
    .filter((model) => isProviderTextModelId(model.id, config))
    .map((model) => ({
      modelName: model.display_name ?? model.name ?? model.id,
      canonicalSlug: model.id,
      contextLength: model.context_length ?? model.contextLength ?? 0,
      completionCost: 0,
      promptCost: 0,
    }));

  return sortModels(models);
}

/**
 * Validate that a model slug exists in the cached model list.
 * Throws with a clear message if the slug is not found.
 * Should be called before using any model from user config.
 */
export async function validateModelSlug(
  slug: string,
  role: "schemaInference" | "populateOrchestrator" | "investigateSubagent"
): Promise<void> {
  const models = await getCachedModels();
  const found = models.some((m) => m.canonicalSlug === slug);
  if (!found) {
    throw new Error(
      `Invalid model slug "${slug}" for ${role}. ` +
        `Available models: ${models.map((m) => m.canonicalSlug).join(", ") || "none (run /openrouter/refresh first)"}`
    );
  }
}

/**
 * Upsert a batch of models to Convex.
 * Called after successfully fetching from OpenRouter API.
 */
export async function upsertModelBatch(models: OpenRouterModel[]): Promise<void> {
  await convex.mutation(internal.openRouterModels.upsertBatch, { models });
}

/**
 * Upsert the model configuration for a specific user in Convex.
 * Only fields that are explicitly provided (not undefined) are updated.
 * Unset fields retain their existing values.
 */
export async function upsertModelConfig(
  userId: string,
  config: {
    schemaInference?: string;
    populateOrchestrator?: string;
    investigateSubagent?: string;
  }
): Promise<void> {
  const llmConfig = await getLlmProviderConfig();
  await convex.mutation(internal.modelConfig.upsertInternal, {
    userId,
    provider: llmConfig?.provider ?? "openrouter",
    schemaInference: config.schemaInference ?? undefined,
    populateOrchestrator: config.populateOrchestrator ?? undefined,
    investigateSubagent: config.investigateSubagent ?? undefined,
  });
}

/**
 * Fetch the model configuration for a specific user from Convex.
 * If the user has no saved config, returns the selected provider default or env defaults.
 * Callers always get a complete config — never null.
 */
export async function getModelConfig(
  userId: string
): Promise<{
  schemaInference: string;
  populateOrchestrator: string;
  investigateSubagent: string;
}> {
  const llmConfig = await getLlmProviderConfig();
  const config = await convex.query(internal.modelConfig.getInternal, {
    userId,
    provider: llmConfig?.provider ?? "openrouter",
  });
  return {
    schemaInference: modelForProvider(
      config?.schemaInference,
      "schemaInference",
      DEFAULT_MODEL_IDS.SCHEMA_INFERENCE,
      llmConfig,
    ),
    populateOrchestrator: modelForProvider(
      config?.populateOrchestrator,
      "populateOrchestrator",
      DEFAULT_MODEL_IDS.POPULATE_ORCHESTRATOR,
      llmConfig,
    ),
    investigateSubagent: modelForProvider(
      config?.investigateSubagent,
      "investigateSubagent",
      DEFAULT_MODEL_IDS.INVESTIGATE_SUBAGENT,
      llmConfig,
    ),
  };
}

/**
 * Fetch models from OpenRouter REST API and return parsed models ready
 * for Convex storage.
 */
export async function fetchModelsFromOpenRouter(): Promise<OpenRouterModel[]> {
  const apiKey = await requireOpenRouterApiKey();

  const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set("output_modalities", "text");
  url.searchParams.set("supported_parameters", "tools");

  // Only text-based models that support tools
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_length?: number;
      pricing?: { completion?: string; prompt?: string };
    }>;
  };

  // Filter excluded and map to OpenRouterModel
  // Prices from OpenRouter are per-token; multiply by 1M for per-million
  const models = json.data
    .filter((m) => !EXCLUDED_MODEL_SLUGS.includes(m.id))
    .map((model) => ({
      modelName: model.name ?? model.id,
      canonicalSlug: model.id,
      contextLength: model.context_length ?? 0,
      promptCost: parseFloat(model.pricing?.prompt ?? "0") * 1_000_000,
      completionCost: parseFloat(model.pricing?.completion ?? "0") * 1_000_000,
    }));

  return models;
}
