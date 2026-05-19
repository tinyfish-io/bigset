import { AiSdkDatasetAgentRuntime } from "./ai-sdk-runtime.js";
import { DeterministicDatasetAgentRuntime } from "./deterministic-runtime.js";
import { createTinyFishToolProvider } from "./tinyfish-tools.js";
import type {
  DatasetAgentRunInput,
  DatasetAgentRuntime,
  DatasetAgentToolProvider,
} from "./types.js";

export type { DatasetAgentRunInput, DatasetAgentRunResult } from "./types.js";

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
    model: input.model ?? process.env.DATASET_AGENT_MODEL ?? "openai/gpt-5.4",
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
