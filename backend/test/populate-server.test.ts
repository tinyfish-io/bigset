import assert from "node:assert/strict";
import { test } from "node:test";

import { createBigSetServer } from "../src/server.js";
import { DEFAULT_COMMIT_ROW_LIMIT_PER_HOUR } from "../src/pipeline/populate-self-healing-command.js";
import type { DatasetContext } from "../src/pipeline/populate.js";
import type { PopulateRecipeRuntime } from "../src/pipeline/populate-self-healing.js";
import type { RunSelfHealingPopulateResult } from "../src/pipeline/populate-self-healing-runner.js";

const context: DatasetContext = {
  datasetId: "dataset-ai-posts",
  datasetName: "AI posts",
  description: "Find latest blog posts from OpenAI.",
  columns: [{
    name: "entity_name",
    type: "text",
    description: "Company name.",
  }],
};

test("POST /populate passes selected runtime into self-healing runner", async () => {
  const selectedRuntime = fakeRuntime();
  let createRuntimeCalls = 0;
  let didUseSelectedRuntime = false;
  const app = await createBigSetServer({
    env: {
      CLIENT_ORIGIN: "http://localhost:3500",
      CONVEX_URL: "http://convex:3210",
      CONVEX_ADMIN_KEY: "convex-admin",
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
      POPULATE_RECIPE_STORE_DIR: ".bigset/populate-recipes",
    },
    runtimeEnv: {
      POPULATE_AGENT_RUNTIME: "collection",
    },
    authPreHandler: async (request) => {
      request.auth = { userId: "user-1" };
    },
    getDatasetById: async (datasetId) => {
      assert.equal(datasetId, context.datasetId);
      return { ownerId: "user-1" };
    },
    populateRowWriter: {
      async replaceRows() {
        return { insertedRowCount: 1 };
      },
    },
    createRuntime: async (input) => {
      createRuntimeCalls += 1;
      assert.equal(input.env.POPULATE_AGENT_RUNTIME, "collection");
      return selectedRuntime;
    },
    runSelfHealing: async (input) => {
      didUseSelectedRuntime = input.runtime === selectedRuntime;
      assert.equal(input.shouldCommitRows, true);
      assert.equal(input.recipeStoreDirectory, ".bigset/populate-recipes");
      assert.ok(input.rowWriter);
      assert.equal(
        input.commitRowLimit?.maxRowsPerWindow,
        DEFAULT_COMMIT_ROW_LIMIT_PER_HOUR
      );
      assert.equal(input.commitRowLimit?.windowMs, 60 * 60 * 1_000);
      return successfulResult(input.context.datasetId);
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/populate",
    payload: context,
  });

  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(createRuntimeCalls, 1);
  assert.equal(didUseSelectedRuntime, true);
  assert.equal(response.json().success, true);
});

function successfulResult(datasetId: string): RunSelfHealingPopulateResult {
  return {
    success: true,
    action: "generated_initial_recipe",
    datasetId,
    selectedRun: {
      rows: [{
        cells: { entity_name: "OpenAI" },
        sourceUrls: ["https://openai.com/news"],
        evidence: [{
          columnName: "entity_name",
          sourceUrl: "https://openai.com/news",
          quote: "OpenAI",
        }],
        needsReview: true,
      }],
      validationIssues: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metrics: {
        searchCalls: 0,
        fetchCalls: 0,
        browserCalls: 0,
        agentRuns: 0,
        agentSteps: 0,
      },
      recipeId: `${datasetId}-recipe-v1`,
      recipeVersion: 1,
      runStatus: "succeeded",
      startedAt: "2026-05-22T00:00:00.000Z",
      completedAt: "2026-05-22T00:00:01.000Z",
      runtimeMs: 1_000,
      productionValidation: {
        state: "accepted_full",
        isValid: true,
        score: 1,
        rowCount: 1,
        safeRowCount: 1,
        requestedCellCompletenessRatio: 1,
        sourceUrlCoverageRatio: 1,
        evidenceCoverageRatio: 1,
        expectedEntityCoverageRatio: 1,
        expectedEntities: [],
        missingExpectedEntities: [],
        coveragePolicy: "partial_allowed",
        targetSource: "public web sources",
        criticalIssues: [],
        warnings: [],
      },
      artifacts: [],
    },
    rejectionReasons: [],
    validationIssues: [],
    tick: {
      datasetId,
      action: "generated_initial_recipe",
      rejectionReasons: [],
    },
  };
}

function fakeRuntime(): PopulateRecipeRuntime {
  return {
    async runRecipe() {
      throw new Error("fake runtime should not execute in route unit tests");
    },
  };
}
