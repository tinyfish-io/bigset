import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DatasetContext } from "../src/pipeline/populate.js";
import {
  createPopulateRecipe,
  FileSystemPopulateRecipeStore,
  InMemoryPopulateRecipeStore,
  type PopulateRecipe,
  type PopulateRecipeAuthor,
  type PopulateRecipeRunResult,
  type PopulateRecipeRuntime,
  type SelfHealingPopulateTickResult,
} from "../src/pipeline/populate-self-healing.js";
import {
  diagnosticRunForTick,
  runSelfHealingPopulate,
  validationIssuesForSelfHealingTick,
  type PopulateDatasetRowWriter,
} from "../src/pipeline/populate-self-healing-runner.js";

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

test("self-healing runner commits rows only after a successful tick", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const generatedRecipe = recipe({ recipeId: "generated-v1" });
  const writer = new FakePopulateDatasetRowWriter();

  const result = await runSelfHealingPopulate({
    context,
    store,
    runtime: new FakePopulateRecipeRuntime({
      "generated-v1": validRun(generatedRecipe),
    }),
    author: new FakeRecipeAuthor({ generatedRecipe }),
    rowWriter: writer,
    shouldCommitRows: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.action, "generated_initial_recipe");
  assert.equal(result.committedRows?.insertedRowCount, 1);
  assert.equal(writer.replaceCalls.length, 1);
  assert.equal(writer.replaceCalls[0]?.datasetId, context.datasetId);
  assert.equal(writer.replaceCalls[0]?.rows[0]?.cells.entity_name, "OpenAI");
});

test("self-healing runner requires a row writer before runtime work when committing", async () => {
  let runtimeCalls = 0;

  await assert.rejects(
    runSelfHealingPopulate({
      context,
      runtime: {
        async runRecipe(input) {
          runtimeCalls += 1;
          return validRun(input.recipe);
        },
      },
      author: new FakeRecipeAuthor({
        generatedRecipe: recipe({ recipeId: "generated-v1" }),
      }),
      shouldCommitRows: true,
    }),
    /rowWriter is required/
  );

  assert.equal(runtimeCalls, 0);
});

test("self-healing runner commits healthy active reruns", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = recipe({ recipeId: "active-v1", status: "active" });
  const writer = new FakePopulateDatasetRowWriter();
  await store.saveRecipe(activeRecipe);

  const result = await runSelfHealingPopulate({
    context,
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-v1": validRun(activeRecipe),
    }),
    author: new FakeRecipeAuthor(),
    rowWriter: writer,
    shouldCommitRows: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.action, "active_rerun_succeeded");
  assert.equal(result.selectedRun?.recipeId, "active-v1");
  assert.equal(writer.replaceCalls.length, 1);
});

test("self-healing runner commits promoted repair candidate rows", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = recipe({ recipeId: "active-broken", status: "active" });
  const repairedRecipe = recipe({ recipeId: "repair-v2", version: 2 });
  const writer = new FakePopulateDatasetRowWriter();
  await store.saveRecipe(activeRecipe);

  const result = await runSelfHealingPopulate({
    context,
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-broken": invalidRun(activeRecipe, "No source-backed rows."),
      "repair-v2": validRun(repairedRecipe),
    }),
    author: new FakeRecipeAuthor({ repairedRecipe }),
    rowWriter: writer,
    shouldCommitRows: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.action, "repaired_active_recipe");
  assert.equal(result.selectedRun?.recipeId, "repair-v2");
  assert.equal(writer.replaceCalls.length, 1);
});

test("self-healing runner does not clear or insert rows when candidate is rejected", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = recipe({ recipeId: "active-broken", status: "active" });
  const rejectedRecipe = recipe({ recipeId: "repair-v2", version: 2 });
  const writer = new FakePopulateDatasetRowWriter();
  await store.saveRecipe(activeRecipe);

  const result = await runSelfHealingPopulate({
    context,
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-broken": invalidRun(activeRecipe, "No source-backed rows."),
      "repair-v2": invalidRun(rejectedRecipe, "Still no evidence."),
    }),
    author: new FakeRecipeAuthor({ repairedRecipe: rejectedRecipe }),
    rowWriter: writer,
    shouldCommitRows: true,
  });

  assert.equal(result.success, false);
  assert.equal(result.action, "candidate_rejected");
  assert.equal(result.selectedRun, undefined);
  assert.equal(result.diagnosticRun?.recipeId, "repair-v2");
  assert.equal(result.committedRows, undefined);
  assert.equal(writer.replaceCalls.length, 0);
  assert.match(result.validationIssues.join("\n"), /Still no evidence/);
});

test("filesystem store lets the runner reuse an active recipe across calls", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "bigset-populate-runner-"));
  const store = new FileSystemPopulateRecipeStore(rootDirectory);
  const generatedRecipe = recipe({ recipeId: "generated-v1" });
  const writer = new FakePopulateDatasetRowWriter();
  const runtime = new FakePopulateRecipeRuntime({
    "generated-v1": validRun(generatedRecipe),
  });
  const author = new FakeRecipeAuthor({ generatedRecipe });

  const first = await runSelfHealingPopulate({
    context,
    store,
    runtime,
    author,
    rowWriter: writer,
    shouldCommitRows: true,
  });
  const second = await runSelfHealingPopulate({
    context,
    store: new FileSystemPopulateRecipeStore(rootDirectory),
    runtime,
    author,
    rowWriter: writer,
    shouldCommitRows: true,
  });

  assert.equal(first.action, "generated_initial_recipe");
  assert.equal(second.action, "active_rerun_succeeded");
  assert.equal(author.generateCalls, 1);
  assert.equal(writer.replaceCalls.length, 2);
});

test("self-healing tick diagnostics expose rejected candidate validation issues", () => {
  const candidateRecipe = recipe({ recipeId: "repair-v2", version: 2 });
  const candidateRun = invalidRun(candidateRecipe, "Missing expected entities: Anthropic.");
  const tick: SelfHealingPopulateTickResult = {
    datasetId: context.datasetId,
    action: "candidate_rejected",
    candidateRecipe,
    candidateRun,
    rejectionReasons: ["Candidate validation score is below the active recipe baseline."],
  };

  assert.equal(diagnosticRunForTick(tick)?.recipeId, "repair-v2");
  assert.deepEqual(validationIssuesForSelfHealingTick(tick), [
    "Missing expected entities: Anthropic.",
    "Candidate validation score is below the active recipe baseline.",
  ]);
});

function recipe(input: {
  recipeId: string;
  version?: number;
  status?: PopulateRecipe["status"];
}): PopulateRecipe {
  return createPopulateRecipe({
    recipeId: input.recipeId,
    datasetId: context.datasetId,
    version: input.version ?? 1,
    status: input.status,
    sourceDescription: context.description,
    requestedColumns: context.columns.map((column) => column.name),
    createdAt: "2026-05-22T00:00:00.000Z",
  });
}

function validRun(recipe: PopulateRecipe): PopulateRecipeRunResult {
  return runResult({
    recipe,
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
      needsReview: true,
    }],
    isValid: true,
    score: 1,
  });
}

function invalidRun(recipe: PopulateRecipe, issue: string): PopulateRecipeRunResult {
  return runResult({
    recipe,
    rows: [],
    validationIssues: [issue],
    criticalIssues: [issue],
    isValid: false,
    score: 0,
  });
}

function runResult(input: {
  recipe: PopulateRecipe;
  rows: PopulateRecipeRunResult["rows"];
  validationIssues?: string[];
  criticalIssues?: string[];
  isValid: boolean;
  score: number;
}): PopulateRecipeRunResult {
  return {
    rows: input.rows,
    validationIssues: input.validationIssues ?? [],
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    metrics: {
      searchCalls: 0,
      fetchCalls: 0,
      browserCalls: 0,
      agentRuns: 0,
      agentSteps: 0,
    },
    recipeId: input.recipe.recipeId,
    recipeVersion: input.recipe.version,
    runStatus: input.isValid ? "succeeded" : "failed",
    startedAt: "2026-05-22T00:00:00.000Z",
    completedAt: "2026-05-22T00:00:01.000Z",
    runtimeMs: 1_000,
    productionValidation: {
      isValid: input.isValid,
      score: input.score,
      rowCount: input.rows.length,
      requestedCellCompletenessRatio: input.score,
      sourceUrlCoverageRatio: input.score,
      evidenceCoverageRatio: input.score,
      expectedEntityCoverageRatio: input.score,
      expectedEntities: [],
      missingExpectedEntities: [],
      criticalIssues: input.criticalIssues ?? [],
      warnings: input.validationIssues ?? [],
    },
    artifacts: [],
  };
}

class FakePopulateRecipeRuntime implements PopulateRecipeRuntime {
  constructor(private readonly runsByRecipeId: Record<string, PopulateRecipeRunResult>) {}

  async runRecipe(input: {
    recipe: PopulateRecipe;
    context: DatasetContext;
  }): Promise<PopulateRecipeRunResult> {
    return this.runsByRecipeId[input.recipe.recipeId] ??
      invalidRun(input.recipe, `Missing fake run for ${input.recipe.recipeId}.`);
  }
}

class FakeRecipeAuthor implements PopulateRecipeAuthor {
  generateCalls = 0;

  constructor(
    private readonly recipes: {
      generatedRecipe?: PopulateRecipe;
      repairedRecipe?: PopulateRecipe;
    } = {}
  ) {}

  async generateRecipe(): Promise<PopulateRecipe> {
    this.generateCalls += 1;
    return this.recipes.generatedRecipe ?? recipe({ recipeId: "generated-v1" });
  }

  async repairRecipe(): Promise<PopulateRecipe> {
    return this.recipes.repairedRecipe ?? recipe({ recipeId: "repair-v2", version: 2 });
  }
}

class FakePopulateDatasetRowWriter implements PopulateDatasetRowWriter {
  readonly replaceCalls: Array<Parameters<PopulateDatasetRowWriter["replaceRows"]>[0]> = [];

  async replaceRows(input: Parameters<PopulateDatasetRowWriter["replaceRows"]>[0]) {
    this.replaceCalls.push(input);
    return {
      clearedRowCount: 7,
      insertedRowCount: input.rows.length,
    };
  }
}
