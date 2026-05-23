import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPopulateRecipeRuntime,
  selectedPopulateRuntimeName,
} from "../src/pipeline/populate-runtime-selection.js";
import { CollectionPopulateRecipeRuntime } from "../src/pipeline/populate-collection-runtime.js";
import {
  createPopulateRecipe,
  MastraPopulateRecipeRuntime,
} from "../src/pipeline/populate-self-healing.js";
import type { DatasetContext } from "../src/pipeline/populate.js";

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

test("populate runtime selection loads collection runner from env module", async () => {
  const runtime = await createPopulateRecipeRuntime({
    env: {
      POPULATE_AGENT_RUNTIME: "collection",
      POPULATE_COLLECTION_RUNNER_MODULE: runnerModuleUrl(),
      BIGSET_BENCHMARK_PROMPT_ID: "latest-ai-blog-posts",
      BIGSET_BENCHMARK_PROMPT_QUALITY: "easy",
      BIGSET_BENCHMARK_PERSONA: "technical operator",
      BIGSET_BENCHMARK_EXPECTED_STRESS: "Latest dated source pages.",
    },
  });
  const context: DatasetContext = {
    datasetId: "dataset-ai-posts",
    datasetName: "AI posts",
    description: "Find latest blog posts from OpenAI.",
    columns: [
      { name: "entity_name", type: "text" },
      { name: "source_url", type: "url" },
      { name: "evidence_quote", type: "text" },
    ],
  };
  const run = await runtime.runRecipe({
    context,
    recipe: createPopulateRecipe({
      recipeId: "collection-v1",
      datasetId: context.datasetId,
      version: 1,
      status: "active",
      runtimeInstructions: "Prefer official sources.",
      sourceDescription: context.description,
      requestedColumns: context.columns.map((column) => column.name),
      createdBy: "system",
    }),
  });

  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.rows[0]?.cells.entity_name, "latest-ai-blog-posts");
  assert.equal(run.rows[0]?.cells.evidence_quote, "technical operator");
});

function runnerModuleUrl(): string {
  const source = `
    export async function runCollectionPopulatePipeline(input) {
      const quote = input.expectedStress || "Loaded runner module.";
      return {
        rows: [{
          cells: {
            entity_name: input.promptId,
            source_url: "https://example.com/source",
            evidence_quote: input.persona,
          },
          sourceUrls: ["https://example.com/source"],
          evidence: [
            { columnName: "entity_name", sourceUrl: "https://example.com/source", quote },
            { columnName: "source_url", sourceUrl: "https://example.com/source", quote },
            { columnName: "evidence_quote", sourceUrl: "https://example.com/source", quote },
          ],
          needsReview: false,
        }],
        validationIssues: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        metrics: {
          searchCalls: 0,
          fetchCalls: 0,
          browserCalls: 0,
          agentRuns: 1,
          agentSteps: 0,
        },
      };
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}
