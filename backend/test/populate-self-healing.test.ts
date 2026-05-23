import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createPopulateRecipe,
  FileSystemPopulateRecipeStore,
  InMemoryPopulateRecipeStore,
  MastraPopulateRecipeRuntime,
  SelfHealingPopulateRecipeService,
} from "../src/pipeline/populate-self-healing.js";
import type {
  PopulateRecipe,
  PopulateRecipeAuthor,
  PopulateRecipeRunResult,
  PopulateRecipeRuntime,
} from "../src/pipeline/populate-self-healing.js";
import type { PopulateAcquisitionResult } from "../src/pipeline/populate-acquisition.js";
import { buildPopulateExtractionSpec } from "../src/pipeline/populate-extraction-spec.js";
import type { DatasetContext } from "../src/pipeline/populate.js";
import { normalizeSearchResultUrl } from "../src/pipeline/populate-search-prioritization.js";
import { buildMockRow, mockTriageExtractHooks } from "./populate-test-hooks.js";

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

test("Mastra populate recipe runtime maps populate rows into a healthy recipe run", async () => {
  const newsUrl = "https://openai.com/news";
  const extractionSpec = buildPopulateExtractionSpec({
    context,
    dataSpec: {
      dataset_name: "ai_posts",
      description: context.description,
      primary_key: "entity_name",
      search_queries: ["openai blog"],
      columns: [
        {
          name: "entity_name",
          display_name: "Company",
          type: "string",
          is_primary_key: true,
          is_enumerable: true,
          description: "Company name.",
          nullable: false,
        },
        {
          name: "latest_post_title",
          display_name: "Post",
          type: "string",
          is_primary_key: false,
          is_enumerable: false,
          description: "Post title.",
          nullable: true,
        },
        {
          name: "source_url",
          display_name: "Source",
          type: "url",
          is_primary_key: false,
          is_enumerable: false,
          description: "Source URL.",
          nullable: true,
        },
        {
          name: "evidence_quote",
          display_name: "Evidence",
          type: "string",
          is_primary_key: false,
          is_enumerable: false,
          description: "Evidence quote.",
          nullable: true,
        },
      ],
    },
  });
  const runtime = new MastraPopulateRecipeRuntime({
    acquisition: selfHealingAcquisition(),
    webTools: {
      search: async () => [],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes from OpenAI",
      }),
    },
    populateHooks: mockTriageExtractHooks({
      recordsByUrl: {
        [newsUrl]: [
          buildMockRow({
            spec: extractionSpec,
            entityName: "OpenAI",
            sourceUrl: newsUrl,
            extraCells: {
              latest_post_title: "Release notes from OpenAI",
              evidence_quote: "Release notes from OpenAI",
            },
            quote: "Release notes from OpenAI",
          }),
        ],
      },
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({
      recipeId: "recipe-v1",
      runtimeInstructions: "Prefer official news pages already known to work.",
    }),
    context,
  });

  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.isValid, true);
  assert.equal(run.productionValidation.score, 1);
  assert.equal(run.recipeId, "recipe-v1");
  assert.equal(run.rows[0]?.cells.entity_name, "OpenAI");
  assert.equal(run.debug?.selectedRowSource, "structured_recovery");
  assert.ok(run.artifacts.some((artifact) => artifact.kind === "source-transcript"));
  assert.ok(run.artifacts.some((artifact) => artifact.kind === "captured-rows"));
});

test("Mastra populate recipe runtime keeps supplemental fetch misses non-blocking", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows(),
      validationIssues: [
        "Structured fallback fetch failed for https://example.com/noise: timeout",
      ],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context,
  });

  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.isValid, true);
  assert.deepEqual(run.productionValidation.criticalIssues, []);
  assert.match(run.productionValidation.warnings.join("\n"), /timeout/);
});

test("Mastra populate recipe runtime blocks missing expected entities", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: [{
        ...validRows()[0]!,
        cells: {
          ...validRows()[0]!.cells,
          latest_post_title:
            "OpenAI roundtable mentions Anthropic and Google DeepMind",
          evidence_quote:
            "OpenAI discussed Anthropic and Google DeepMind in passing.",
        },
        evidence: [{
          columnName: "latest_post_title",
          sourceUrl: "https://openai.com/news",
          quote: "OpenAI discussed Anthropic and Google DeepMind in passing.",
        }],
      }],
      validationIssues: [],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context: {
      ...context,
      description:
        "Find latest blog posts from OpenAI, Anthropic, and Google DeepMind.",
    },
  });

  assert.equal(run.runStatus, "failed");
  assert.equal(run.productionValidation.isValid, false);
  assert.deepEqual(run.productionValidation.expectedEntities, [
    "OpenAI",
    "Anthropic",
    "Google DeepMind",
  ]);
  assert.deepEqual(run.productionValidation.missingExpectedEntities, [
    "Anthropic",
    "Google DeepMind",
  ]);
  assert.match(
    run.productionValidation.criticalIssues.join("\n"),
    /Missing expected entities/
  );
});

test("self-healing service reruns a healthy active recipe without author repair", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = recipe({ recipeId: "active-v1", status: "active" });
  await store.saveRecipe(activeRecipe);
  const author = new FakeRecipeAuthor();
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-v1": validRun(activeRecipe),
    }),
    author,
  });

  const result = await service.tick({ datasetId: context.datasetId, context });

  assert.equal(result.action, "active_rerun_succeeded");
  assert.equal(author.generateCalls, 0);
  assert.equal(author.repairCalls, 0);
  assert.equal(result.activeRecipe?.status, "active");
  assert.equal(result.activeRecipe?.lastValidationScore, 1);
});

test("self-healing service generates and activates the first valid recipe", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const generatedRecipe = recipe({ recipeId: "generated-v1" });
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "generated-v1": validRun(generatedRecipe),
    }),
    author: new FakeRecipeAuthor({ generatedRecipe }),
  });

  const result = await service.tick({ datasetId: context.datasetId, context });
  const snapshot = await store.loadSnapshot(context.datasetId);

  assert.equal(result.action, "generated_initial_recipe");
  assert.equal(result.activeRecipe?.recipeId, "generated-v1");
  assert.equal(snapshot.recipes[0]?.status, "active");
  assert.equal(snapshot.runRecords.length, 1);
});

test("self-healing service normalizes author recipe metadata before storing", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const generatedRecipe = createPopulateRecipe({
    recipeId: "generated-v1",
    datasetId: "wrong-dataset",
    version: 99,
    status: "active",
    sourceDescription: "wrong prompt",
    requestedColumns: ["wrong_column"],
  });
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "generated-v1": validRun({
        ...generatedRecipe,
        datasetId: context.datasetId,
        version: 1,
        status: "candidate",
      }),
    }),
    author: new FakeRecipeAuthor({ generatedRecipe }),
  });

  const result = await service.tick({ datasetId: context.datasetId, context });
  const snapshot = await store.loadSnapshot(context.datasetId);

  assert.equal(result.action, "generated_initial_recipe");
  assert.equal(result.activeRecipe?.datasetId, context.datasetId);
  assert.equal(result.activeRecipe?.version, 1);
  assert.equal(result.activeRecipe?.status, "active");
  assert.deepEqual(
    result.activeRecipe?.requestedColumns,
    context.columns.map((column) => column.name)
  );
  assert.equal(snapshot.recipes.length, 1);
  assert.equal(snapshot.recipes[0]?.datasetId, context.datasetId);
});

test("self-healing service uses tick dataset id as the runtime context id", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const generatedRecipe = recipe({ recipeId: "generated-v1" });
  let runtimeContextDatasetId = "";
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: {
      async runRecipe(input) {
        runtimeContextDatasetId = input.context.datasetId;
        return validRun(input.recipe);
      },
    },
    author: new FakeRecipeAuthor({ generatedRecipe }),
  });

  await service.tick({
    datasetId: context.datasetId,
    context: {
      ...context,
      datasetId: "wrong-dataset",
    },
  });

  assert.equal(runtimeContextDatasetId, context.datasetId);
});

test("self-healing service repairs a failed active recipe and promotes the candidate", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = recipe({ recipeId: "active-broken", status: "active" });
  const repairedRecipe = recipe({ recipeId: "repair-v2", version: 2 });
  await store.saveRecipe(activeRecipe);
  const author = new FakeRecipeAuthor({ repairedRecipe });
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-broken": invalidRun(activeRecipe, "No source-backed rows."),
      "repair-v2": validRun(repairedRecipe),
    }),
    author,
  });

  const result = await service.tick({ datasetId: context.datasetId, context });
  const snapshot = await store.loadSnapshot(context.datasetId);

  assert.equal(result.action, "repaired_active_recipe");
  assert.equal(author.repairCalls, 1);
  assert.equal(author.lastRepairInput?.failedRun.runStatus, "failed");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === "active-broken")?.status, "retired");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === "repair-v2")?.status, "active");
});

test("self-healing service rejects valid repairs below active recipe baseline", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = {
    ...recipe({ recipeId: "active-broken", status: "active" }),
    lastValidationScore: 1,
  };
  const weakerRepair = recipe({ recipeId: "repair-v2", version: 2 });
  await store.saveRecipe(activeRecipe);
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-broken": invalidRun(activeRecipe, "Transient source outage."),
      "repair-v2": validRun(weakerRepair, 0.75),
    }),
    author: new FakeRecipeAuthor({ repairedRecipe: weakerRepair }),
  });

  const result = await service.tick({ datasetId: context.datasetId, context });
  const snapshot = await store.loadSnapshot(context.datasetId);

  assert.equal(result.action, "candidate_rejected");
  assert.match(result.rejectionReasons.join("\n"), /active recipe baseline/);
  assert.equal(snapshot.recipes.find((item) => item.recipeId === "active-broken")?.status, "active");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === "repair-v2")?.status, "rejected");
});

test("self-healing service rejects a repaired candidate that still fails validation", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const activeRecipe = recipe({ recipeId: "active-broken", status: "active" });
  const rejectedRecipe = recipe({ recipeId: "bad-repair", version: 2 });
  await store.saveRecipe(activeRecipe);
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-broken": invalidRun(activeRecipe, "No source-backed rows."),
      "bad-repair": invalidRun(rejectedRecipe, "Still no evidence."),
    }),
    author: new FakeRecipeAuthor({ repairedRecipe: rejectedRecipe }),
  });

  const result = await service.tick({ datasetId: context.datasetId, context });
  const snapshot = await store.loadSnapshot(context.datasetId);

  assert.equal(result.action, "candidate_rejected");
  assert.match(result.rejectionReasons.join("\n"), /Still no evidence/);
  assert.equal(snapshot.recipes.find((item) => item.recipeId === "active-broken")?.status, "active");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === "bad-repair")?.status, "rejected");
});

test("file store reloads populate recipes and run records", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "bigset-populate-recipes-"));
  const store = new FileSystemPopulateRecipeStore(rootDirectory);
  const generatedRecipe = recipe({ recipeId: "persisted-v1" });
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "persisted-v1": validRun(generatedRecipe),
    }),
    author: new FakeRecipeAuthor({ generatedRecipe }),
  });

  await service.tick({ datasetId: context.datasetId, context });

  const reloadedStore = new FileSystemPopulateRecipeStore(rootDirectory);
  const snapshot = await reloadedStore.loadSnapshot(context.datasetId);

  assert.equal(snapshot.recipes.length, 1);
  assert.equal(snapshot.recipes[0]?.status, "active");
  assert.equal(snapshot.runRecords.length, 1);
  assert.equal(snapshot.runRecords[0]?.runStatus, "succeeded");
});

interface ToolLike<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

function recipe(input: {
  recipeId: string;
  version?: number;
  status?: PopulateRecipe["status"];
  runtimeInstructions?: string;
}): PopulateRecipe {
  return createPopulateRecipe({
    recipeId: input.recipeId,
    datasetId: context.datasetId,
    version: input.version ?? 1,
    status: input.status,
    sourceDescription: context.description,
    requestedColumns: context.columns.map((column) => column.name),
    runtimeInstructions: input.runtimeInstructions,
    createdAt: "2026-05-22T00:00:00.000Z",
  });
}

function validRun(recipe: PopulateRecipe, score = 1): PopulateRecipeRunResult {
  return runResult({
    recipe,
    rows: validRows(),
    isValid: true,
    score,
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

function validRows(): PopulateRecipeRunResult["rows"] {
  return [
    {
      cells: {
        entity_name: "OpenAI",
        latest_post_title: "Release notes from OpenAI",
        source_url: "https://openai.com/news",
        evidence_quote: "Release notes from OpenAI",
      },
      sourceUrls: ["https://openai.com/news"],
      evidence: [
        {
          columnName: "latest_post_title",
          sourceUrl: "https://openai.com/news",
          quote: "Release notes from OpenAI",
        },
      ],
      needsReview: true,
    },
  ];
}

function emptyUsage(): PopulateRecipeRunResult["usage"] {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function emptyMetrics(): PopulateRecipeRunResult["metrics"] {
  return {
    searchCalls: 0,
    fetchCalls: 0,
    browserCalls: 0,
    agentRuns: 0,
    agentSteps: 0,
  };
}

function selfHealingAcquisition(): PopulateAcquisitionResult {
  const url = "https://openai.com/news";
  return {
    prioritizedUrls: [normalizeSearchResultUrl(url)],
    scoredUrls: [
      {
        url,
        expectation_score: 5,
        search_query: "OpenAI official blog latest post",
      },
    ],
    initialQueries: ["OpenAI official blog latest post"],
    validationIssues: [],
  };
}

class FakePopulateRecipeRuntime implements PopulateRecipeRuntime {
  constructor(private readonly runsByRecipeId: Record<string, PopulateRecipeRunResult>) {}

  async runRecipe(input: {
    recipe: PopulateRecipe;
    context: DatasetContext;
  }): Promise<PopulateRecipeRunResult> {
    const run = this.runsByRecipeId[input.recipe.recipeId];
    if (!run) {
      return invalidRun(input.recipe, `Missing fake run for ${input.recipe.recipeId}.`);
    }
    return run;
  }
}

class FakeRecipeAuthor implements PopulateRecipeAuthor {
  generateCalls = 0;
  repairCalls = 0;
  lastRepairInput?: Parameters<PopulateRecipeAuthor["repairRecipe"]>[0];

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

  async repairRecipe(
    input: Parameters<PopulateRecipeAuthor["repairRecipe"]>[0]
  ): Promise<PopulateRecipe> {
    this.repairCalls += 1;
    this.lastRepairInput = input;
    return this.recipes.repairedRecipe ?? recipe({ recipeId: "repair-v2", version: 2 });
  }
}
