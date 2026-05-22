import {
  CollectionPopulateRecipeRuntime,
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
  if (!input.collectionRunner) {
    throw new Error(
      "POPULATE_AGENT_RUNTIME=collection requires a collection pipeline runner."
    );
  }
  return new CollectionPopulateRecipeRuntime({
    runPipeline: input.collectionRunner,
    targetRows: input.maxRows,
  });
}
