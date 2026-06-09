import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { env } from "../env.js";
import { FETCH_TIMEOUT_MS } from "../fetch-timeout.js";

export const LLM_PROVIDER_TYPES = [
  "openrouter",
  "openai",
  "anthropic",
  "custom",
] as const;

export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];

export type ModelRoleKey =
  | "schemaInference"
  | "populateOrchestrator"
  | "investigateSubagent";

export interface LlmProviderConfig {
  provider: LlmProviderType;
  apiKey: string;
  defaultModel: string;
  baseUrl?: string;
  source: "local" | "env";
}

export interface LlmProviderInput {
  provider: LlmProviderType;
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
}

export const LLM_PROVIDER_LABELS: Record<LlmProviderType, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "Custom OpenAI-compatible",
};

export const LLM_PROVIDER_DEFAULT_MODELS_BY_ROLE: Record<
  LlmProviderType,
  Record<ModelRoleKey, string>
> = {
  openrouter: {
    schemaInference: env.SCHEMA_INFERENCE_MODEL,
    populateOrchestrator: env.POPULATE_ORCHESTRATOR_MODEL,
    investigateSubagent: env.INVESTIGATE_SUBAGENT_MODEL,
  },
  openai: {
    schemaInference: "gpt-5.4-mini",
    populateOrchestrator: "gpt-5.4-mini",
    investigateSubagent: "gpt-5.4-mini",
  },
  anthropic: {
    schemaInference: "claude-sonnet-4-6",
    populateOrchestrator: "claude-haiku-4-5-20251001",
    investigateSubagent: "claude-haiku-4-5-20251001",
  },
  custom: {
    schemaInference: "",
    populateOrchestrator: "",
    investigateSubagent: "",
  },
};

export const LLM_PROVIDER_DEFAULT_MODELS: Record<LlmProviderType, string> = {
  openrouter: LLM_PROVIDER_DEFAULT_MODELS_BY_ROLE.openrouter.schemaInference,
  openai: LLM_PROVIDER_DEFAULT_MODELS_BY_ROLE.openai.schemaInference,
  anthropic: LLM_PROVIDER_DEFAULT_MODELS_BY_ROLE.anthropic.schemaInference,
  custom: "",
};

export function isLlmProviderType(value: unknown): value is LlmProviderType {
  return (
    typeof value === "string" &&
    (LLM_PROVIDER_TYPES as readonly string[]).includes(value)
  );
}

export function llmProviderLabel(provider: LlmProviderType): string {
  return LLM_PROVIDER_LABELS[provider];
}

export function defaultModelForLlmProvider(provider: LlmProviderType): string {
  return LLM_PROVIDER_DEFAULT_MODELS[provider];
}

export function defaultModelForLlmProviderRole(
  provider: LlmProviderType,
  role: ModelRoleKey,
): string {
  return LLM_PROVIDER_DEFAULT_MODELS_BY_ROLE[provider][role];
}

export function defaultBaseUrlForLlmProvider(
  provider: LlmProviderType,
): string | undefined {
  if (provider === "openrouter") {
    return process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  }
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(
    hostname,
  );
}

function normalizeLocalLoopbackForBackend(parsed: URL): void {
  if (env.IS_LOCAL_MODE && isLoopbackHost(parsed.hostname)) {
    // In local dev the backend runs inside Docker. From the container,
    // localhost points at the container, not the host machine where LM Studio
    // and other local OpenAI-compatible servers usually listen.
    parsed.hostname = "host.docker.internal";
  }
}

export function normalizeBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL must start with http:// or https://");
  }
  normalizeLocalLoopbackForBackend(parsed);
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeCustomBaseUrl(baseUrl?: string): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return undefined;

  const parsed = new URL(normalized);
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/v1";
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeLlmProviderInput(
  input: LlmProviderInput,
  source: "local" | "env",
): LlmProviderConfig {
  const provider = input.provider;
  const apiKey = input.apiKey.trim();
  if (!apiKey && provider !== "custom") {
    throw new Error(`${llmProviderLabel(provider)} API key is required`);
  }

  const baseUrl =
    provider === "custom"
      ? normalizeCustomBaseUrl(input.baseUrl)
      : normalizeBaseUrl(input.baseUrl) ?? defaultBaseUrlForLlmProvider(provider);

  if (provider === "custom" && !baseUrl) {
    throw new Error("Custom providers require a base URL");
  }

  const defaultModel =
    input.defaultModel?.trim() || defaultModelForLlmProvider(provider);

  return {
    provider,
    apiKey,
    defaultModel,
    baseUrl,
    source,
  };
}

export function createLanguageModel(
  config: LlmProviderConfig,
  modelId?: string,
): LanguageModelV3 {
  const resolvedModelId = (modelId?.trim() || config.defaultModel).trim();
  if (!resolvedModelId) {
    throw new Error("Model name is required");
  }

  switch (config.provider) {
    case "openrouter": {
      const provider = createOpenRouter({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return provider(resolvedModelId);
    }
    case "openai": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return provider(resolvedModelId);
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return provider(resolvedModelId);
    }
    case "custom": {
      if (!config.baseUrl) {
        throw new Error("Custom providers require a base URL");
      }
      const provider = createOpenAICompatible({
        name: "custom",
        apiKey: config.apiKey || undefined,
        baseURL: config.baseUrl,
      });
      return provider(resolvedModelId);
    }
  }
}

function providerVerificationRequest(config: LlmProviderConfig): {
  url: string;
  headers: Record<string, string>;
} {
  switch (config.provider) {
    case "openrouter": {
      const baseUrl = (config.baseUrl || "https://openrouter.ai/api/v1").replace(
        /\/+$/,
        "",
      );
      return {
        url: `${baseUrl}/key`,
        headers: { Authorization: `Bearer ${config.apiKey}` },
      };
    }
    case "openai": {
      const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(
        /\/+$/,
        "",
      );
      return {
        url: `${baseUrl}/models`,
        headers: { Authorization: `Bearer ${config.apiKey}` },
      };
    }
    case "anthropic": {
      const baseUrl = (config.baseUrl || "https://api.anthropic.com/v1").replace(
        /\/+$/,
        "",
      );
      return {
        url: `${baseUrl}/models?limit=1`,
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
      };
    }
    case "custom": {
      if (!config.baseUrl) {
        throw new Error("Custom providers require a base URL");
      }
      const baseUrl = config.baseUrl.replace(/\/+$/, "");
      return {
        url: `${baseUrl}/models`,
        headers: config.apiKey
          ? { Authorization: `Bearer ${config.apiKey}` }
          : {},
      };
    }
  }
}

export async function verifyLlmProviderConfig(
  config: LlmProviderConfig,
): Promise<void> {
  const { url, headers } = providerVerificationRequest(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${llmProviderLabel(config.provider)} rejected that API key.`);
      }
      throw new Error(
        `${llmProviderLabel(config.provider)} verification failed with HTTP ${response.status}.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `${llmProviderLabel(config.provider)} verification timed out after ${FETCH_TIMEOUT_MS / 1000} seconds.`,
      );
    }
    if (err instanceof Error && err.message === "fetch failed") {
      const displayUrl = url.replace("host.docker.internal", "localhost");
      throw new Error(
        `${llmProviderLabel(config.provider)} verification failed: could not reach ${displayUrl}. If this is LM Studio, start the local server and use http://localhost:1234 or http://localhost:1234/v1.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
