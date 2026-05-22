#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const prompt = requiredEnv("BIGSET_BENCHMARK_PROMPT");
const promptId = process.env.BIGSET_BENCHMARK_PROMPT_ID ?? "benchmark-prompt";
const promptQuality = process.env.BIGSET_BENCHMARK_PROMPT_QUALITY ?? "unknown";
const requiredColumns = columnList(
  requiredEnv("BIGSET_BENCHMARK_REQUIRED_COLUMNS")
);
const minimumRequiredColumns = columnList(
  process.env.BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS ?? ""
);

const missingRuntimeKeys = ["OPENROUTER_API_KEY", "TINYFISH_API_KEY"].filter(
  (name) => !process.env[name]
);
if (missingRuntimeKeys.length > 0) {
  console.log(JSON.stringify({
    rows: [],
    validationIssues: [
      `Missing ${missingRuntimeKeys.join(", ")} for collection self-healing benchmark.`,
    ],
    usage: emptyUsage(),
    metrics: emptyMetrics(),
  }));
  process.exit(0);
}

const collectionRunner = await loadCollectionRunner();
if (!collectionRunner) {
  console.log(JSON.stringify({
    rows: [],
    validationIssues: [
      "Collection self-healing benchmark runner is not configured. Set BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE to a module exporting runCollectionPopulatePipeline(input).",
    ],
    usage: emptyUsage(),
    metrics: emptyMetrics(),
  }));
  process.exit(0);
}

const {
  diagnosticRunForTick,
  validationIssuesForSelfHealingTick,
} = await import(
  "../../../backend/src/pipeline/populate-self-healing-runner.ts"
);
const {
  DefaultPopulateRecipeAuthor,
  InMemoryPopulateRecipeStore,
  SelfHealingPopulateRecipeService,
} = await import(
  "../../../backend/src/pipeline/populate-self-healing.ts"
);
const {
  CollectionPopulateRecipeRuntime,
} = await import(
  "../../../backend/src/pipeline/populate-collection-runtime.ts"
);

const context = {
  datasetId: `benchmark-${safeIdSegment(promptId)}`,
  datasetName: `benchmark_${safeIdSegment(promptId)}`,
  description: prompt,
  columns: requiredColumns.map((columnName) => ({
    name: columnName,
    type: inferPopulateColumnType(columnName),
    description: `Benchmark requested column for ${promptQuality} prompt.`,
  })),
};
const service = new SelfHealingPopulateRecipeService({
  store: new InMemoryPopulateRecipeStore(),
  runtime: new CollectionPopulateRecipeRuntime({
    runPipeline: collectionRunner,
    targetRows: Number(process.env.BIGSET_COLLECTION_BENCHMARK_MAX_ROWS ?? "10"),
  }),
  author: new DefaultPopulateRecipeAuthor(),
});
const tick = await service.tick({ datasetId: context.datasetId, context });
const result = diagnosticRunForTick(tick);

console.log(JSON.stringify({
  rows: result?.rows ?? [],
  validationIssues: [
    ...validationIssuesForSelfHealingTick(tick),
    ...minimumColumnIssues(result?.rows ?? []),
  ],
  usage: result?.usage ?? emptyUsage(),
  metrics: result?.metrics ?? emptyMetrics(),
}));

async function loadCollectionRunner() {
  const moduleSpecifier = process.env.BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE;
  if (!moduleSpecifier) {
    return undefined;
  }
  const moduleUrl = moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")
    ? pathToFileURL(resolve(moduleSpecifier)).href
    : moduleSpecifier;
  const loaded = await import(moduleUrl);
  const runner = loaded.runCollectionPopulatePipeline ?? loaded.default;
  if (typeof runner !== "function") {
    throw new Error(
      `${moduleSpecifier} must export runCollectionPopulatePipeline(input) or a default runner.`
    );
  }
  return runner;
}

function minimumColumnIssues(rows) {
  const issues = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const columnName of minimumRequiredColumns) {
      const value = row.cells?.[columnName];
      if (value === undefined || value === null || value === "") {
        issues.push(`Row ${rowIndex} missing minimum required column ${columnName}.`);
      }
    }
  }
  return issues;
}

function inferPopulateColumnType(columnName) {
  if (/(url|website|link|page)$/i.test(columnName)) return "url";
  if (/(date|_at)$/i.test(columnName)) return "date";
  if (/^(is_|has_|can_)/i.test(columnName)) return "boolean";
  if (/(count|price|amount|score|number|total)/i.test(columnName)) return "number";
  return "text";
}

function safeIdSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function columnList(value) {
  return value
    .split(",")
    .map((columnName) => columnName.trim())
    .filter(Boolean);
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyMetrics() {
  return {
    searchCalls: 0,
    fetchCalls: 0,
    browserCalls: 0,
    agentRuns: 0,
    agentSteps: 0,
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run through run-benchmark.mjs.`);
  }
  return value;
}
