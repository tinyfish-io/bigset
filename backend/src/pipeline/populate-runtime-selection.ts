import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CollectionPopulateRecipeRuntime,
  type CollectionPopulateBenchmarkMetadata,
  type CollectionPopulatePipelineRunner,
} from "./populate-collection-runtime.js";
import {
  MastraPopulateRecipeRuntime,
  type PopulateRecipeRuntime,
} from "./populate-self-healing.js";

export type PopulateAgentRuntimeName = "mastra" | "collection";

export interface CreatePopulateRecipeRuntimeInput {
  env: NodeJS.ProcessEnv;
  maxRows?: number;
  collectionRunner?: CollectionPopulatePipelineRunner;
}

export function selectedPopulateRuntimeName(
  env: NodeJS.ProcessEnv
): PopulateAgentRuntimeName {
  const rawRuntimeName = (
    env.POPULATE_AGENT_RUNTIME ??
    env.DATASET_AGENT_RUNTIME ??
    "mastra"
  ).trim().toLowerCase();

  if (rawRuntimeName === "mastra" || rawRuntimeName === "mastra-populate") {
    return "mastra";
  }
  if (rawRuntimeName === "collection") {
    return "collection";
  }
  throw new Error(
    `Unsupported POPULATE_AGENT_RUNTIME: ${rawRuntimeName || "(empty)"}.`
  );
}

export async function createPopulateRecipeRuntime(
  input: CreatePopulateRecipeRuntimeInput
): Promise<PopulateRecipeRuntime> {
  const runtimeName = selectedPopulateRuntimeName(input.env);
  if (runtimeName === "mastra") {
    return new MastraPopulateRecipeRuntime({ maxRows: input.maxRows });
  }
  const collectionRunner =
    input.collectionRunner ?? await loadCollectionRunnerFromEnv(input.env);
  if (!collectionRunner) {
    throw new Error(
      "POPULATE_AGENT_RUNTIME=collection requires a collection pipeline runner or POPULATE_COLLECTION_RUNNER_MODULE."
    );
  }
  return new CollectionPopulateRecipeRuntime({
    runPipeline: collectionRunner,
    targetRows: input.maxRows,
    benchmarkMetadata: collectionBenchmarkMetadataFromEnv(input.env),
  });
}

async function loadCollectionRunnerFromEnv(
  env: NodeJS.ProcessEnv
): Promise<CollectionPopulatePipelineRunner | undefined> {
  const moduleSpecifier = env.POPULATE_COLLECTION_RUNNER_MODULE;
  if (!moduleSpecifier) {
    return undefined;
  }

  const moduleUrl = moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")
    ? pathToFileURL(resolve(moduleSpecifier)).href
    : moduleSpecifier;
  const loadedModule = await import(moduleUrl);
  const runner = loadedModule.runCollectionPopulatePipeline ?? loadedModule.default;
  if (typeof runner !== "function") {
    throw new Error(
      `${moduleSpecifier} must export runCollectionPopulatePipeline(input) or a default runner.`
    );
  }
  return runner as CollectionPopulatePipelineRunner;
}

function collectionBenchmarkMetadataFromEnv(
  env: NodeJS.ProcessEnv
): CollectionPopulateBenchmarkMetadata {
  return {
    promptId: env.BIGSET_BENCHMARK_PROMPT_ID,
    promptQuality: env.BIGSET_BENCHMARK_PROMPT_QUALITY,
    persona: env.BIGSET_BENCHMARK_PERSONA,
    expectedStress: env.BIGSET_BENCHMARK_EXPECTED_STRESS,
  };
}
