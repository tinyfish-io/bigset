import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as ts from "typescript";

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
import {
  createPlaywrightScriptArtifact,
  populateRuntimeResultFromAgentCompatibleResult,
} from "../src/pipeline/populate-browser-action-box.js";
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

test("Mastra populate recipe runtime maps populate rows into a healthy recipe run", async () => {
  let promptText = "";
  const runtime = new MastraPopulateRecipeRuntime({
    webTools: {
      search: async () => [
        {
          title: "OpenAI news",
          snippet: "Release notes from OpenAI",
          url: "https://openai.com/news",
        },
      ],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes from OpenAI",
      }),
    },
    agentRunner: async ({ prompt, tools }) => {
      promptText = prompt;
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { results?: unknown[] }
      >;
      const fetchPage = tools.fetch_page as ToolLike<
        { url: string },
        { text?: string }
      >;
      const insertRow = tools.insert_row as ToolLike<
        { datasetId: string; data: Record<string, unknown> },
        { success: boolean }
      >;
      await searchWeb.execute({ query: "OpenAI latest blog" });
      await fetchPage.execute({ url: "https://openai.com/news" });
      await insertRow.execute({
        datasetId: context.datasetId,
        data: {
          entity_name: "OpenAI",
          latest_post_title: "Release notes from OpenAI",
          source_url: "https://openai.com/news",
          evidence_quote: "Release notes from OpenAI",
        },
      });
    },
  });

  const run = await runtime.runRecipe({
    recipe: recipe({
      recipeId: "recipe-v1",
      runtimeInstructions: "Prefer official news pages already known to work.",
    }),
    context,
  });

  assert.match(promptText, /Durable recipe instructions/);
  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.isValid, true);
  assert.equal(run.productionValidation.score, 1);
  assert.equal(run.recipeId, "recipe-v1");
  assert.equal(run.rows[0]?.cells.entity_name, "OpenAI");
  assert.equal(run.debug?.selectedRowSource, "insert_row");
  assert.ok(run.artifacts.some((artifact) => artifact.kind === "source-transcript"));
  assert.ok(run.artifacts.some((artifact) => artifact.kind === "captured-rows"));
  const traceArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "process-trace"
  );
  assert.ok(traceArtifact);
  const trace = JSON.parse(traceArtifact.content);
  assert.equal(trace.runtime, "mastra-injected");
  assert.deepEqual(trace.searchQueries, ["OpenAI latest blog"]);
  assert.deepEqual(trace.fetchedUrls, ["https://openai.com/news"]);
  assert.equal(trace.selectedRowSource, "insert_row");
  const readinessArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "playwright-candidate-readiness"
  );
  assert.ok(readinessArtifact);
  const readiness = JSON.parse(readinessArtifact.content);
  assert.equal(readiness.status, "not_ready");
  assert.match(readiness.reasons.join("\n"), /no actionable browser steps/i);
  assert.equal(
    run.artifacts.some((artifact) => artifact.kind === "playwright-candidate-script"),
    false
  );
});

test("Mastra populate recipe runtime emits Playwright candidate script for ready browser traces", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows(),
      validationIssues: [],
      usage: emptyUsage(),
      metrics: {
        ...emptyMetrics(),
        browserCalls: 1,
      },
      debug: {
        capturedRows: [],
        capturedSources: [],
        selectedRowSource: "collection_pipeline",
        notes: [],
        processTrace: {
          runtime: "collection",
          searchQueries: ["OpenAI pricing docs"],
          fetchedUrls: ["https://openai.com/news"],
          sourceArtifacts: [{
            url: "https://openai.com/news",
            status: "succeeded",
            source: "collection",
          }],
          selectedRowSource: "collection_pipeline",
          notes: [],
          steps: [{
            kind: "browser",
            label: "open-news-link",
            status: "succeeded",
            input: {
              phase: "initial",
            },
            browserAction: {
              action: "click",
              url: "https://openai.com/news",
              selector: "a[href*='/news']",
              targetText: "News",
            },
          }],
        },
      },
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context,
  });

  const readinessArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "playwright-candidate-readiness"
  );
  assert.ok(readinessArtifact);
  assert.equal(JSON.parse(readinessArtifact.content).status, "ready");

  const scriptArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "playwright-candidate-script"
  );
  assert.ok(scriptArtifact);
  assert.match(scriptArtifact.content, /export async function runDatasetRecipe/);
  assert.match(scriptArtifact.content, /a\[href\*='\/news'\]/);
  assert.match(scriptArtifact.content, /clickTarget/);
  assert.match(scriptArtifact.content, /https:\/\/openai\.com\/news/);
  assert.ok(scriptArtifact.content.length <= 20_000);
  assertJavaScriptModuleParses(scriptArtifact.content);
});

test("Mastra populate recipe runtime keeps Playwright candidate scripts complete under artifact cap", async () => {
  const longText = "x".repeat(2_000);
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows(),
      validationIssues: [],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
      debug: {
        capturedRows: [],
        capturedSources: [],
        selectedRowSource: "collection_pipeline",
        notes: [],
        processTrace: {
          runtime: "collection",
          searchQueries: [],
          fetchedUrls: ["https://example.com/catalog"],
          sourceArtifacts: [{
            url: "https://example.com/catalog",
            status: "succeeded",
            source: "collection",
          }],
          selectedRowSource: "collection_pipeline",
          notes: [],
          steps: Array.from({ length: 10 }, (_, index) => ({
            kind: "browser" as const,
            label: `long-ready-action-${index}-${longText}`,
            status: "succeeded" as const,
            input: {
              phase: "initial",
            },
            browserAction: {
              action: "click" as const,
              url: `https://example.com/catalog/${index}`,
              selector: `[data-long="${longText}-${index}"]`,
              targetText: `${longText}-${index}`,
              valueDescription: `${longText}-${index}`,
            },
          })),
        },
      },
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context,
  });

  const readinessArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "playwright-candidate-readiness"
  );
  assert.ok(readinessArtifact);
  assert.equal(JSON.parse(readinessArtifact.content).status, "ready");

  const scriptArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "playwright-candidate-script"
  );
  assert.ok(scriptArtifact);
  assert.ok(scriptArtifact.content.length <= 20_000);
  assert.match(scriptArtifact.content, /Omitted 5 lower-priority browser actions/);
  assertJavaScriptModuleParses(scriptArtifact.content);
});

test("Mastra populate recipe runtime replays promoted Playwright script before agent spend", async () => {
  let replayCalls = 0;
  let populateCalls = 0;
  const promotedScript = createPlaywrightScriptArtifact({
    sourceUrl: "https://openai.com/news",
    datasetGoalPrompt: context.description,
    datasetSchema: {
      columns: context.columns.map((column) => ({
        name: column.name,
        required: true,
      })),
    },
    code: "export async function runDatasetRecipe() { return { records: [] }; }",
    status: "promoted",
    createdAt: "2026-05-24T00:00:00.000Z",
  });
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => {
      populateCalls += 1;
      throw new Error("normal populate should not run before replay");
    },
    browserActionBox: {
      async replay(input) {
        replayCalls += 1;
        const agentCompatibleResult = {
          records: [{
            entity_name: "OpenAI",
            latest_post_title: "Release notes from OpenAI",
            source_url: "https://openai.com/news",
            evidence_quote: "Release notes from OpenAI",
            evidence: [{
              field: "latest_post_title",
              url: "https://openai.com/news",
              quote: "Release notes from OpenAI",
            }],
          }],
        };
        return {
          agentCompatibleResult,
          runtimeResult: populateRuntimeResultFromAgentCompatibleResult({
            agentCompatibleResult,
            datasetSchema: input.datasetSchema,
            sourceUrl: input.sourceUrl,
            replayTrace: {
              status: "succeeded",
              startedAt: "2026-05-24T00:00:00.000Z",
              completedAt: "2026-05-24T00:00:01.000Z",
              scriptId: input.currentPlaywrightScript.scriptId,
              sourceUrl: input.sourceUrl,
              diagnostics: [],
              steps: [{
                kind: "browser",
                label: "playwright-replay",
                status: "succeeded",
              }],
            },
            diagnosticArtifacts: [{
              kind: "playwright-replay-result",
              label: "populate-playwright-replay-result",
              content: JSON.stringify({ replayStatus: "replay_succeeded" }),
            }],
          }),
          trace: {
            status: "succeeded",
            startedAt: "2026-05-24T00:00:00.000Z",
            completedAt: "2026-05-24T00:00:01.000Z",
            scriptId: input.currentPlaywrightScript.scriptId,
            sourceUrl: input.sourceUrl,
            diagnostics: [],
            steps: [],
          },
          replayStatus: "replay_succeeded",
          diagnostics: [],
        };
      },
    },
  });

  const run = await runtime.runRecipe({
    recipe: recipe({
      recipeId: "recipe-v1",
      playwrightScript: promotedScript,
    }),
    context,
  });

  assert.equal(replayCalls, 1);
  assert.equal(populateCalls, 0);
  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.isValid, true);
  assert.ok(run.artifacts.some((artifact) =>
    artifact.kind === "playwright-replay-result"
  ));
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

test("Mastra populate recipe runtime treats nullable missing cells as non-blocking", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows(),
      validationIssues: [
        "Author field could not be determined from the available source transcript.",
      ],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context: {
      ...context,
      columns: [
        ...context.columns,
        {
          name: "author",
          type: "text",
          description: "Author when the source names one.",
          nullable: true,
        },
      ],
    },
  });

  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.isValid, true);
  assert.deepEqual(run.productionValidation.criticalIssues, []);
  assert.equal(run.productionValidation.requestedCellCompletenessRatio, 0.8);
});

test("Mastra populate recipe runtime rejects approximated required cells", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows(),
      validationIssues: [
        "Actual post titles and canonical URLs are not present in the captured transcript, so category+date combinations are used as best approximations. These rows require manual review.",
      ],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context: {
      ...context,
      columns: [
        ...context.columns,
        {
          name: "author",
          type: "text",
          description: "Author when the source names one.",
          nullable: true,
        },
      ],
    },
  });

  assert.equal(run.runStatus, "failed");
  assert.equal(run.productionValidation.isValid, false);
  assert.match(
    run.productionValidation.criticalIssues.join("\n"),
    /best approximations/
  );
});

test("Mastra populate recipe runtime rejects evidence disconnected from row sources", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows().map((row) => ({
        ...row,
        evidence: [{
          columnName: "latest_post_title",
          sourceUrl: "https://example.com/unrelated",
          quote: "Release notes from OpenAI",
        }],
      })),
      validationIssues: [],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context,
  });

  assert.equal(run.runStatus, "failed");
  assert.equal(run.productionValidation.isValid, false);
  assert.match(
    run.productionValidation.criticalIssues.join("\n"),
    /does not match a row source URL/
  );
});

test("process trace artifacts stay parseable when trace content is large", async () => {
  const runtime = new MastraPopulateRecipeRuntime({
    runPopulate: async () => ({
      rows: validRows(),
      validationIssues: [],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
      debug: {
        capturedRows: [],
        capturedSources: [],
        selectedRowSource: "collection_pipeline",
        notes: [],
        processTrace: {
          runtime: "collection",
          searchQueries: Array.from({ length: 125 }, (_, index) =>
            `query-${index}-${"x".repeat(1_000)}`
          ),
          fetchedUrls: [],
          sourceArtifacts: [],
          selectedRowSource: "collection_pipeline",
          notes: ["n".repeat(1_000)],
          steps: Array.from({ length: 125 }, (_, index) => ({
            kind: "search" as const,
            label: `collection-search-query-${index}`,
            status: "succeeded" as const,
            input: { query: "x".repeat(1_000) },
          })),
        },
      },
    }),
  });

  const run = await runtime.runRecipe({
    recipe: recipe({ recipeId: "recipe-v1" }),
    context,
  });
  const traceArtifact = run.artifacts.find((artifact) =>
    artifact.kind === "process-trace"
  );

  assert.ok(traceArtifact);
  assert.ok(traceArtifact.content.length <= 20_000);
  const parsedTrace = JSON.parse(traceArtifact.content);
  assert.equal(parsedTrace.truncated, true);
  assert.ok(parsedTrace.steps.length > 0);
  assert.ok(parsedTrace.steps.length <= 100);
  assert.match(parsedTrace.searchQueries[0], /\[truncated\]/);
});

test("Mastra populate recipe runtime marks missing expected entities as partial", async () => {
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

  assert.equal(run.runStatus, "succeeded");
  assert.equal(run.productionValidation.state, "accepted_partial");
  assert.equal(run.productionValidation.isValid, false);
  assert.equal(run.productionValidation.safeRowCount, 1);
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

test("self-healing service does not run a second recipe repair after bounded Playwright repair rejects", async () => {
  const store = new InMemoryPopulateRecipeStore();
  const promotedScript = createPlaywrightScriptArtifact({
    sourceUrl: "https://openai.com/news",
    datasetGoalPrompt: context.description,
    datasetSchema: {
      columns: context.columns.map((column) => ({
        name: column.name,
        required: true,
      })),
    },
    code: "export async function runDatasetRecipe() { throw new Error('stale selector'); }",
    status: "promoted",
    createdAt: "2026-05-24T00:00:00.000Z",
  });
  const activeRecipe = {
    ...recipe({
      recipeId: "active-playwright-broken",
      status: "active",
      playwrightScript: promotedScript,
    }),
    lastValidationScore: 1,
  };
  await store.saveRecipe(activeRecipe);
  const author = new FakeRecipeAuthor();
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: new FakePopulateRecipeRuntime({
      "active-playwright-broken": runResult({
        recipe: activeRecipe,
        rows: [],
        validationIssues: ["BrowserActionBox repair_rejected: locator timed out"],
        criticalIssues: ["BrowserActionBox repair_rejected: locator timed out"],
        isValid: false,
        score: 0,
        artifacts: [{
          kind: "playwright-repair-diagnostic",
          label: "populate-playwright-repair-diagnostic",
          content: JSON.stringify({
            replayStatus: "repair_rejected",
            diagnostics: ["locator timed out"],
          }),
        }],
      }),
    }),
    author,
  });

  const result = await service.tick({ datasetId: context.datasetId, context });
  const snapshot = await store.loadSnapshot(context.datasetId);

  assert.equal(result.action, "candidate_rejected");
  assert.equal(author.repairCalls, 0);
  assert.match(result.rejectionReasons.join("\n"), /keeping prior active script/i);
  assert.equal(
    snapshot.recipes.find((item) =>
      item.recipeId === "active-playwright-broken"
    )?.status,
    "active"
  );
  assert.equal(snapshot.recipes.some((item) => item.recipeId === "repair-v2"), false);
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
      "persisted-v1": validRun(generatedRecipe, 1, [processTraceArtifact()]),
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
  assert.equal(snapshot.runRecords[0]?.artifacts[0]?.kind, "process-trace");
  assert.match(
    snapshot.runRecords[0]?.artifacts[0]?.content ?? "",
    /collection-search-query/
  );
});

interface ToolLike<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

function recipe(input: {
  recipeId: string;
  version?: number;
  status?: PopulateRecipe["status"];
  runtimeInstructions?: string;
  playwrightScript?: PopulateRecipe["playwrightScript"];
}): PopulateRecipe {
  return {
    ...createPopulateRecipe({
      recipeId: input.recipeId,
      datasetId: context.datasetId,
      version: input.version ?? 1,
      status: input.status,
      sourceDescription: context.description,
      requestedColumns: context.columns.map((column) => column.name),
      runtimeInstructions: input.runtimeInstructions,
      createdAt: "2026-05-22T00:00:00.000Z",
    }),
    playwrightScript: input.playwrightScript,
  };
}

function validRun(
  recipe: PopulateRecipe,
  score = 1,
  artifacts: PopulateRecipeRunResult["artifacts"] = []
): PopulateRecipeRunResult {
  return runResult({
    recipe,
    rows: validRows(),
    isValid: true,
    score,
    artifacts,
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
  artifacts?: PopulateRecipeRunResult["artifacts"];
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
      state: input.isValid ? "accepted_full" : "rejected",
      isValid: input.isValid,
      score: input.score,
      rowCount: input.rows.length,
      safeRowCount: input.isValid ? input.rows.length : 0,
      requestedCellCompletenessRatio: input.score,
      sourceUrlCoverageRatio: input.score,
      evidenceCoverageRatio: input.score,
      expectedEntityCoverageRatio: input.score,
      expectedEntities: [],
      missingExpectedEntities: [],
      coveragePolicy: "partial_allowed",
      targetSource: "public web sources",
      criticalIssues: input.criticalIssues ?? [],
      warnings: input.validationIssues ?? [],
    },
    artifacts: input.artifacts ?? [],
  };
}

function processTraceArtifact(): PopulateRecipeRunResult["artifacts"][number] {
  return {
    kind: "process-trace",
    label: "populate-process-trace",
    content: JSON.stringify({
      runtime: "collection",
      searchQueries: ["OpenAI latest blog"],
      fetchedUrls: ["https://openai.com/news"],
      sourceArtifacts: [{
        url: "https://openai.com/news",
        status: "succeeded",
        source: "collection",
      }],
      selectedRowSource: "collection_pipeline",
      notes: [],
      steps: [{
        kind: "search",
        label: "collection-search-query",
        status: "succeeded",
        input: { query: "OpenAI latest blog" },
      }],
    }),
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

function assertJavaScriptModuleParses(source: string): void {
  const sourceFile = ts.createSourceFile(
    "playwright-candidate-script.mjs",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  assert.deepEqual(
    sourceFile.parseDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    ),
    []
  );
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
