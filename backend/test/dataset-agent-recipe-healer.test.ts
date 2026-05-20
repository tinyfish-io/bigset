import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyRecipePromotionDecision,
  createDatasetRecipe,
  FakeDatasetRecipeRuntime,
} from "../src/dataset-agent/index.js";
import type {
  DatasetAgentRunInput,
  DatasetRecipeRunResult,
} from "../src/dataset-agent/index.js";

const runInput: DatasetAgentRunInput = {
  prompt: "Find latest blog posts from OpenAI with title, date, and URL.",
  promptId: "recipe-oracle-latest-posts",
  promptQuality: "good",
  requiredColumns: ["entity_name", "latest_post_title", "source_url"],
};

const activeRecipe = createDatasetRecipe({
  recipeId: "recipe-active",
  datasetId: "dataset-ai-posts",
  version: 1,
  status: "active",
  scriptText: "export async function runDatasetRecipe() {}",
  requestedColumns: runInput.requiredColumns,
  sourcePrompt: runInput.prompt,
  createdAt: "2026-05-21T00:00:00.000Z",
});

test("fake recipe runtime returns current dataset-agent contract plus production validation", async () => {
  const runtime = new FakeDatasetRecipeRuntime({
    [activeRecipe.recipeId]: {
      rawOutput: {
        rows: [
          sourceBackedRow({
            entity_name: "OpenAI",
            source_url: "https://openai.com/news",
          }),
        ],
        validationIssues: [],
      },
    },
  });

  const result = await runtime.runRecipe({ recipe: activeRecipe, runInput });

  assert.equal(result.recipeId, activeRecipe.recipeId);
  assert.equal(result.rows.length, 1);
  assert.equal(result.productionValidation.isValid, true);
  assert.equal(result.productionValidation.minimumRequiredCompletenessRatio, 1);
  assert.equal(result.productionValidation.requestedCellCompletenessRatio, 0.667);
  assert.equal(result.productionValidation.warnings.length, 1);
});

test("production validation rejects rows missing the conservative identity field", async () => {
  const runtime = new FakeDatasetRecipeRuntime({
    [activeRecipe.recipeId]: {
      rawOutput: {
        rows: [
          sourceBackedRow({
            latest_post_title: "Release notes",
            source_url: "https://openai.com/news",
          }),
        ],
        validationIssues: [],
      },
    },
  });

  const result = await runtime.runRecipe({ recipe: activeRecipe, runInput });

  assert.equal(result.productionValidation.isValid, false);
  assert.match(
    result.productionValidation.criticalIssues.join("\n"),
    /entity_name/i
  );
});

test("promotion accepts a valid candidate that improves requested-cell completeness", async () => {
  const candidateRecipe = createDatasetRecipe({
    recipeId: "recipe-candidate",
    datasetId: activeRecipe.datasetId,
    version: 2,
    scriptText: "export async function runDatasetRecipe() { return 'better'; }",
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
    createdAt: "2026-05-21T00:01:00.000Z",
  });
  const activeRun = await runFakeRecipe(activeRecipe, {
    entity_name: "OpenAI",
    source_url: "https://openai.com/news",
  });
  const candidateRun = await runFakeRecipe(candidateRecipe, {
    entity_name: "OpenAI",
    latest_post_title: "Release notes",
    source_url: "https://openai.com/news",
  });

  const promotion = applyRecipePromotionDecision({
    activeRecipe,
    candidateRecipe,
    activeRun,
    candidateRun,
  });

  assert.equal(promotion.decision.shouldPromote, true);
  assert.equal(promotion.activeRecipe.recipeId, candidateRecipe.recipeId);
  assert.equal(promotion.activeRecipe.status, "active");
  assert.equal(promotion.retiredRecipe?.status, "retired");
});

test("promotion rejects a candidate that regresses production validation score", async () => {
  const candidateRecipe = createDatasetRecipe({
    recipeId: "recipe-worse",
    datasetId: activeRecipe.datasetId,
    version: 2,
    scriptText: "export async function runDatasetRecipe() { return 'worse'; }",
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
  });
  const activeRun = await runFakeRecipe(activeRecipe, {
    entity_name: "OpenAI",
    latest_post_title: "Release notes",
    source_url: "https://openai.com/news",
  });
  const candidateRun = await runFakeRecipe(candidateRecipe, {
    entity_name: "OpenAI",
    source_url: "https://openai.com/news",
  });

  const promotion = applyRecipePromotionDecision({
    activeRecipe,
    candidateRecipe,
    activeRun,
    candidateRun,
  });

  assert.equal(promotion.decision.shouldPromote, false);
  assert.equal(promotion.activeRecipe.recipeId, activeRecipe.recipeId);
  assert.match(
    promotion.decision.rejectionReasons.join("\n"),
    /production validation score regressed/i
  );
});

test("promotion rejects a candidate when benchmark score regresses", async () => {
  const candidateRecipe = createDatasetRecipe({
    recipeId: "recipe-benchmark-regression",
    datasetId: activeRecipe.datasetId,
    version: 2,
    scriptText: "export async function runDatasetRecipe() { return 'fuller but wrong'; }",
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
  });
  const activeRun = await runFakeRecipe(
    activeRecipe,
    {
      entity_name: "OpenAI",
      source_url: "https://openai.com/news",
    },
    { score: 0.8, passed: true }
  );
  const candidateRun = await runFakeRecipe(
    candidateRecipe,
    {
      entity_name: "OpenAI",
      latest_post_title: "Release notes",
      source_url: "https://openai.com/news",
    },
    { score: 0.7, passed: true }
  );

  const promotion = applyRecipePromotionDecision({
    activeRecipe,
    candidateRecipe,
    activeRun,
    candidateRun,
  });

  assert.equal(promotion.decision.shouldPromote, false);
  assert.match(
    promotion.decision.rejectionReasons.join("\n"),
    /benchmark score regressed/i
  );
});

async function runFakeRecipe(
  recipe: typeof activeRecipe,
  cells: Record<string, string>,
  benchmarkScore?: DatasetRecipeRunResult["benchmarkScore"]
): Promise<DatasetRecipeRunResult> {
  const runtime = new FakeDatasetRecipeRuntime({
    [recipe.recipeId]: {
      rawOutput: {
        rows: [sourceBackedRow(cells)],
        validationIssues: [],
      },
      benchmarkScore,
      completedAt: "2026-05-21T00:02:00.000Z",
    },
  });

  return runtime.runRecipe({ recipe, runInput });
}

function sourceBackedRow(cells: Record<string, string>) {
  const sourceUrl = cells.source_url ?? "https://openai.com/news";

  return {
    cells,
    sourceUrls: [sourceUrl],
    evidence: [
      {
        columnName: Object.keys(cells)[0] ?? "entity_name",
        sourceUrl,
        quote: Object.values(cells)[0] ?? "OpenAI",
      },
    ],
    needsReview: false,
  };
}
