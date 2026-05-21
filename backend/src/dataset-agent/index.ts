import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import { AiSdkDatasetAgentRuntime } from "./ai-sdk-runtime.js";
import { DeterministicDatasetAgentRuntime } from "./deterministic-runtime.js";
import { createTinyFishToolProvider } from "./tinyfish-tools.js";
import type {
  DatasetAgentRunInput,
  DatasetAgentRuntime,
  DatasetAgentToolProvider,
} from "./types.js";

export const DEFAULT_DATASET_AGENT_MODEL = "google/gemini-3.1-flash-lite";

export type { DatasetAgentRunInput, DatasetAgentRunResult } from "./types.js";
export {
  applyRecipePromotionDecision,
  decideRecipePromotion,
} from "./recipe-healer.js";
export {
  createDatasetRecipe,
  createDatasetRecipeRunResult,
  emptyRecipeRunResult,
  evaluateRecipeProductionValidation,
  FakeDatasetRecipeRuntime,
} from "./recipe-runtime.js";
export {
  PlaywrightRecipeRunner,
} from "./playwright-recipe-runner.js";
export type {
  DatasetRecipe,
  DatasetRecipeArtifact,
  DatasetRecipeBenchmarkScore,
  DatasetRecipeProductionValidation,
  DatasetRecipeRunInput,
  DatasetRecipeRunResult,
  DatasetRecipeRuntime,
} from "./recipe-types.js";
export type {
  DatasetRecipeBrowserFactory,
  DatasetRecipeBrowserSession,
  DatasetRecipePageLike,
  DatasetRecipeScriptContext,
} from "./playwright-recipe-runner.js";

export function createDatasetAgentRuntime(input: {
  runtime?: string;
  model?: string;
  maxSteps?: number;
  toolProvider?: DatasetAgentToolProvider;
} = {}): DatasetAgentRuntime {
  const runtime = input.runtime ?? process.env.DATASET_AGENT_RUNTIME ?? "ai-sdk";

  if (runtime === "deterministic") {
    return new DeterministicDatasetAgentRuntime();
  }

  const toolProvider =
    input.toolProvider ??
    createTinyFishToolProvider({
      apiKey: process.env.TINYFISH_API_KEY,
      timeoutMs: numberEnv("TINYFISH_TIMEOUT_MS", 60_000),
    });

  if (!toolProvider) {
    throw new Error(
      "Missing TINYFISH_API_KEY. Load it execution-only or set DATASET_AGENT_RUNTIME=deterministic for local smoke tests."
    );
  }

  return new AiSdkDatasetAgentRuntime({
    model: createOpenRouterDatasetAgentModel(
      input.model ?? process.env.DATASET_AGENT_MODEL ?? DEFAULT_DATASET_AGENT_MODEL
    ),
    maxSteps: input.maxSteps ?? numberEnv("DATASET_AGENT_MAX_STEPS", 8),
    toolProvider,
  });
}

export async function runDatasetAgentFromEnv(input: DatasetAgentRunInput) {
  return createDatasetAgentRuntime().runDatasetBuild(input);
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createOpenRouterDatasetAgentModel(modelId: string): LanguageModel {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Load it execution-only for the OpenRouter Gemini dataset-agent model."
    );
  }

  return createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    appName: "BigSet Dataset Agent",
  })(modelId);
}
