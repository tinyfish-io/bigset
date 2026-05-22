#!/usr/bin/env node

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
      `Missing ${missingRuntimeKeys.join(", ")} for Mastra populate benchmark.`,
    ],
    usage: emptyUsage(),
    metrics: emptyMetrics(),
  }));
  process.exit(0);
}

const { runPopulateRuntime } = await import(
  "../../../backend/src/pipeline/populate-runtime.ts"
);

const result = await runPopulateRuntime({
  context: {
    datasetId: `benchmark-${safeIdSegment(promptId)}`,
    datasetName: `benchmark_${safeIdSegment(promptId)}`,
    description: prompt,
    columns: requiredColumns.map((columnName) => ({
      name: columnName,
      type: inferPopulateColumnType(columnName),
      description: `Benchmark requested column for ${promptQuality} prompt.`,
    })),
  },
  maxRows: Number(process.env.BIGSET_MASTRA_BENCHMARK_MAX_ROWS ?? "10"),
});

console.log(JSON.stringify({
  ...result,
  validationIssues: [
    ...result.validationIssues,
    ...minimumColumnIssues(result.rows),
  ],
}));

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
