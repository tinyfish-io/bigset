import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CollectionPopulateRecipeRuntime,
  collectionPipelineInputFromRecipe,
  type CollectionPopulatePipelineInput,
} from "../src/pipeline/populate-collection-runtime.js";
import {
  createPopulateRecipe,
  type PopulateRecipe,
} from "../src/pipeline/populate-self-healing.js";
import type { DatasetContext } from "../src/pipeline/populate.js";

const context: DatasetContext = {
  datasetId: "dataset-ai-posts",
  datasetName: "AI posts",
  description: "Find latest blog posts from OpenAI.",
  columns: [
    {
      name: "entity_name",
      type: "text",
      description: "Company name.",
    },
    {
      name: "latest_post_title",
      type: "text",
      description: "Post title.",
    },
    {
      name: "source_url",
      type: "url",
      description: "Source URL.",
    },
    {
      name: "evidence_quote",
      type: "text",
      description: "Evidence quote.",
    },
  ],
};

test("collection runtime threads recipe instructions into the collection prompt", async () => {
  let capturedInput: CollectionPopulatePipelineInput | undefined;
  const runtime = new CollectionPopulateRecipeRuntime({
    targetRows: 3,
    runPipeline: async (input) => {
      capturedInput = input;
      return {
        rows: [{
          cells: {
            entity_name: "OpenAI",
            latest_post_title: "Release notes from OpenAI",
            source_url: "https://openai.com/news",
            evidence_quote: "Release notes from OpenAI",
          },
          sourceUrls: ["https://openai.com/news"],
          evidence: [{
            columnName: "latest_post_title",
            sourceUrl: "https://openai.com/news",
            quote: "Release notes from OpenAI",
          }],
          needsReview: false,
        }],
        validationIssues: [],
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
        metrics: {
          searchCalls: 1,
          fetchCalls: 1,
          browserCalls: 0,
          agentRuns: 1,
          agentSteps: 0,
        },
      };
    },
  });
  const recipe = collectionRecipe({
    runtimeInstructions:
      "Prefer official news pages already known to work. Do not use aggregator pages.",
  });

  const run = await runtime.runRecipe({ recipe, context });

  assert.ok(capturedInput);
  assert.equal(capturedInput.datasetId, context.datasetId);
  assert.equal(capturedInput.datasetName, context.datasetName);
  assert.equal(capturedInput.targetRows, 3);
  assert.deepEqual(capturedInput.requiredColumns, [
    "entity_name",
    "latest_post_title",
    "source_url",
    "evidence_quote",
  ]);
  assert.match(capturedInput.prompt, /Find latest blog posts from OpenAI/);
  assert.match(capturedInput.prompt, /Durable recipe instructions/);
  assert.match(capturedInput.prompt, /Do not use aggregator pages/);
  assert.equal(
    capturedInput.recipeInstructions,
    "Prefer official news pages already known to work. Do not use aggregator pages."
  );
  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.isValid, true);
  assert.equal(run.productionValidation.score, 1);
  assert.equal(run.rows[0]?.cells.entity_name, "OpenAI");
});

test("collection pipeline input builder trims empty recipe instructions", () => {
  const input = collectionPipelineInputFromRecipe({
    recipe: collectionRecipe({ runtimeInstructions: "   " }),
    context,
    targetRows: 5,
  });

  assert.equal(input.recipeInstructions, "");
  assert.doesNotMatch(input.prompt, /Durable recipe instructions/);
});

function collectionRecipe(input: {
  runtimeInstructions?: string;
} = {}): PopulateRecipe {
  return createPopulateRecipe({
    recipeId: "collection-v1",
    datasetId: context.datasetId,
    version: 1,
    status: "active",
    runtimeInstructions: input.runtimeInstructions ?? "",
    sourceDescription: context.description,
    requestedColumns: context.columns.map((column) => column.name),
    createdBy: "system",
  });
}
