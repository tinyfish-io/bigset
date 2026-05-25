import assert from "node:assert/strict";
import { test } from "node:test";

import type { DatasetContext } from "../src/pipeline/populate.js";
import type { PopulateRecipeRuntime } from "../src/pipeline/populate-self-healing.js";
import type { RunSelfHealingPopulateResult } from "../src/pipeline/populate-self-healing-runner.js";
import {
  DEFAULT_COMMIT_ROW_LIMIT_PER_HOUR,
  parsePopulateSelfHealingCliArgs,
  runPopulateSelfHealingCli,
} from "../src/pipeline/populate-self-healing-command.js";

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

test("self-healing CLI parses context and dry-run mode", () => {
  assert.deepEqual(parsePopulateSelfHealingCliArgs([
    "--context",
    "context.json",
    "--max-rows",
    "3",
  ]), {
    contextPath: "context.json",
    shouldReadStdin: false,
    shouldCommitRows: false,
    maxRows: 3,
  });
});

test("self-healing CLI parses dataset-id mode", () => {
  assert.deepEqual(parsePopulateSelfHealingCliArgs([
    "--dataset-id",
    "dataset-ai-posts",
    "--commit",
  ]), {
    datasetId: "dataset-ai-posts",
    shouldReadStdin: false,
    shouldCommitRows: true,
  });
});

test("self-healing CLI parses commit row limit override", () => {
  assert.deepEqual(parsePopulateSelfHealingCliArgs([
    "--dataset-id",
    "dataset-ai-posts",
    "--commit",
    "--commit-row-limit-per-hour",
    "250",
  ]), {
    datasetId: "dataset-ai-posts",
    shouldReadStdin: false,
    shouldCommitRows: true,
    commitRowLimitPerHour: 250,
  });
});

test("self-healing CLI rejects dataset-id mixed with context input", () => {
  assert.throws(
    () => parsePopulateSelfHealingCliArgs([
      "--dataset-id",
      "dataset-ai-posts",
      "--context",
      "context.json",
    ]),
    /Choose exactly one context source/
  );
  assert.throws(
    () => parsePopulateSelfHealingCliArgs([
      "--context",
      "context.json",
      "--dataset-id",
      "dataset-ai-posts",
    ]),
    /Choose exactly one context source/
  );
  assert.throws(
    () => parsePopulateSelfHealingCliArgs([
      "--dataset-id",
      "dataset-ai-posts",
      "--stdin",
    ]),
    /Choose exactly one context source/
  );
  assert.throws(
    () => parsePopulateSelfHealingCliArgs([
      "--stdin",
      "--dataset-id",
      "dataset-ai-posts",
    ]),
    /Choose exactly one context source/
  );
});

test("self-healing CLI rejects context and stdin mixed in any order", () => {
  assert.throws(
    () => parsePopulateSelfHealingCliArgs([
      "--context",
      "context.json",
      "--stdin",
    ]),
    /Choose exactly one context source/
  );
  assert.throws(
    () => parsePopulateSelfHealingCliArgs([
      "--stdin",
      "--context",
      "context.json",
    ]),
    /Choose exactly one context source/
  );
});

test("self-healing CLI dry run does not require Convex admin key or create writer", async () => {
  const stdout: string[] = [];
  let runCalls = 0;
  let writerCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    createRowWriter: async () => {
      writerCalls += 1;
      throw new Error("writer should not be created");
    },
    runSelfHealing: async (input) => {
      runCalls += 1;
      assert.equal(input.shouldCommitRows, false);
      assert.equal(input.rowWriter, undefined);
      assert.equal(input.recipeStoreDirectory, undefined);
      assert.ok(input.store);
      return successfulResult(input.context.datasetId);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(runCalls, 1);
  assert.equal(writerCalls, 0);
  assert.equal(stdout.length, 1);
  const output = JSON.parse(stdout[0]!);
  assert.equal(output.success, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.rowCount, 1);
});

test("self-healing CLI passes selected runtime into the runner", async () => {
  const stdout: string[] = [];
  const selectedRuntime = fakeRuntime();
  let createRuntimeCalls = 0;
  let didUseSelectedRuntime = false;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
      POPULATE_AGENT_RUNTIME: "collection",
    },
    readFileText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    createRuntime: async (input) => {
      createRuntimeCalls += 1;
      assert.equal(input.env.POPULATE_AGENT_RUNTIME, "collection");
      return selectedRuntime;
    },
    runSelfHealing: async (input) => {
      didUseSelectedRuntime = input.runtime === selectedRuntime;
      return successfulResult(input.context.datasetId);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(createRuntimeCalls, 1);
  assert.equal(didUseSelectedRuntime, true);
  assert.equal(JSON.parse(stdout[0]!).success, true);
});

test("self-healing CLI dataset-id dry run loads context before running", async () => {
  const stdout: string[] = [];
  let loadedDatasetId = "";
  let didReadFile = false;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--dataset-id", "dataset-ai-posts"],
    env: {
      CONVEX_URL: "http://convex:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-admin",
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => {
      didReadFile = true;
      return JSON.stringify(context);
    },
    loadDatasetContextById: async (datasetId) => {
      loadedDatasetId = datasetId;
      return context;
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async (input) => {
      assert.equal(input.context.datasetId, context.datasetId);
      assert.equal(input.shouldCommitRows, false);
      assert.ok(input.store);
      assert.equal(input.rowWriter, undefined);
      return successfulResult(input.context.datasetId);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(loadedDatasetId, "dataset-ai-posts");
  assert.equal(didReadFile, false);
  assert.equal(JSON.parse(stdout[0]!).success, true);
});

test("self-healing CLI dataset-id commit loads context and creates writer", async () => {
  const stdout: string[] = [];
  let writerCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--dataset-id", "dataset-ai-posts", "--commit"],
    env: {
      CONVEX_URL: "http://convex:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-admin",
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
      POPULATE_RECIPE_STORE_DIR: ".bigset/populate-recipes",
    },
    loadDatasetContextById: async (datasetId) => ({
      ...context,
      datasetId,
    }),
    createRowWriter: async () => {
      writerCalls += 1;
      return {
        async replaceRows() {
          return { insertedRowCount: 1 };
        },
      };
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async (input) => {
      assert.equal(input.context.datasetId, "dataset-ai-posts");
      assert.equal(input.shouldCommitRows, true);
      assert.equal(input.store, undefined);
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

  assert.equal(exitCode, 0);
  assert.equal(writerCalls, 1);
  assert.equal(JSON.parse(stdout[0]!).success, true);
});

test("self-healing CLI dataset-id mode preflights Convex keys before loading context", async () => {
  const stdout: string[] = [];
  let loadCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--dataset-id", "dataset-ai-posts"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    loadDatasetContextById: async () => {
      loadCalls += 1;
      return context;
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
  });

  assert.equal(exitCode, 1);
  assert.equal(loadCalls, 0);
  assert.match(stdout[0]!, /CONVEX_URL/);
  assert.match(stdout[0]!, /CONVEX_SELF_HOSTED_ADMIN_KEY/);
});

test("self-healing CLI dataset-id loader failures skip runtime and writer", async () => {
  const stdout: string[] = [];
  let runCalls = 0;
  let writerCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--dataset-id", "not-a-convex-id", "--commit"],
    env: {
      CONVEX_URL: "http://convex:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-admin",
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    loadDatasetContextById: async () => {
      throw new Error("Invalid dataset id: not-a-convex-id.");
    },
    createRowWriter: async () => {
      writerCalls += 1;
      return {
        async replaceRows() {
          return { insertedRowCount: 0 };
        },
      };
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async () => {
      runCalls += 1;
      throw new Error("runtime should not run");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(runCalls, 0);
  assert.equal(writerCalls, 0);
  assert.match(stdout[0]!, /Invalid dataset id/);
});

test("self-healing CLI rejects durable recipe store on dry run", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let didReadContext = false;
  const exitCode = await runPopulateSelfHealingCli({
    argv: [
      "--stdin",
      "--recipe-store-dir",
      ".bigset/test-recipes",
    ],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readStdinText: async () => {
      didReadContext = true;
      return JSON.stringify(context);
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    runSelfHealing: async () => {
      throw new Error("runtime should not run");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(didReadContext, false);
  assert.equal(stdout.length, 1);
  assert.match(stdout[0]!, /--recipe-store-dir requires --commit/);
  assert.match(stderr.join("\n"), /--recipe-store-dir requires --commit/);
});

test("self-healing CLI commit mode preflights missing Convex key before runtime", async () => {
  const stdout: string[] = [];
  let runCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json", "--commit"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async () => {
      runCalls += 1;
      throw new Error("runtime should not run");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(runCalls, 0);
  assert.equal(stdout.length, 1);
  assert.match(stdout[0]!, /CONVEX_SELF_HOSTED_ADMIN_KEY/);
});

test("self-healing CLI exits 2 when tick rejects candidate", async () => {
  const stdout: string[] = [];
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--stdin"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readStdinText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async (input) => rejectedResult(input.context.datasetId),
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.length, 1);
  const output = JSON.parse(stdout[0]!);
  assert.equal(output.success, false);
  assert.equal(output.action, "candidate_rejected");
  assert.match(output.validationIssues.join("\n"), /Still no evidence/);
});

test("self-healing CLI reports malformed context JSON as one stdout object", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => "{ nope",
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]!).success, false);
  assert.match(stderr.join("\n"), /JSON/);
});

function successfulResult(datasetId: string): RunSelfHealingPopulateResult {
  return {
    success: true,
    action: "generated_initial_recipe",
    datasetId,
    selectedRun: {
      ...baseRun(datasetId),
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

function rejectedResult(datasetId: string): RunSelfHealingPopulateResult {
  return {
    success: false,
    action: "candidate_rejected",
    datasetId,
    diagnosticRun: {
      ...baseRun(datasetId),
      runStatus: "failed",
      validationIssues: ["Still no evidence."],
      productionValidation: {
        ...baseRun(datasetId).productionValidation,
        state: "rejected",
        isValid: false,
        score: 0,
        safeRowCount: 0,
        criticalIssues: ["Still no evidence."],
      },
    },
    rejectionReasons: ["Still no evidence."],
    validationIssues: ["Still no evidence."],
    tick: {
      datasetId,
      action: "candidate_rejected",
      rejectionReasons: ["Still no evidence."],
    },
  };
}

function baseRun(datasetId: string): RunSelfHealingPopulateResult["selectedRun"] {
  return {
    rows: [],
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
  };
}

function fakeRuntime(): PopulateRecipeRuntime {
  return {
    async runRecipe() {
      throw new Error("fake runtime should not execute in CLI unit tests");
    },
  };
}
