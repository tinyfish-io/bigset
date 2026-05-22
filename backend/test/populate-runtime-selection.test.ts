import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPopulateRecipeRuntime,
  selectedPopulateRuntimeName,
} from "../src/pipeline/populate-runtime-selection.js";
import { CollectionPopulateRecipeRuntime } from "../src/pipeline/populate-collection-runtime.js";
import { MastraPopulateRecipeRuntime } from "../src/pipeline/populate-self-healing.js";

test("populate runtime selection defaults to Mastra", async () => {
  assert.equal(selectedPopulateRuntimeName({}), "mastra");
  assert.ok(
    await createPopulateRecipeRuntime({ env: {} }) instanceof
      MastraPopulateRecipeRuntime
  );
});

test("populate runtime selection supports collection when a runner is provided", async () => {
  assert.equal(
    selectedPopulateRuntimeName({ POPULATE_AGENT_RUNTIME: "collection" }),
    "collection"
  );
  const runtime = await createPopulateRecipeRuntime({
    env: { POPULATE_AGENT_RUNTIME: "collection" },
    collectionRunner: async () => ({
      rows: [],
      validationIssues: ["not used"],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metrics: {
        searchCalls: 0,
        fetchCalls: 0,
        browserCalls: 0,
        agentRuns: 0,
        agentSteps: 0,
      },
    }),
  });

  assert.ok(runtime instanceof CollectionPopulateRecipeRuntime);
});

test("populate runtime selection rejects collection without a runner", async () => {
  await assert.rejects(
    () => createPopulateRecipeRuntime({
      env: { POPULATE_AGENT_RUNTIME: "collection" },
    }),
    /requires a collection pipeline runner/
  );
});
