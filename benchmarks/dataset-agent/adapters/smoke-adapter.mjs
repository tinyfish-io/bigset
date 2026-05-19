#!/usr/bin/env node

const prompt = process.env.BIGSET_BENCHMARK_PROMPT ?? "";
const promptId = process.env.BIGSET_BENCHMARK_PROMPT_ID ?? "unknown";
const requiredColumns = (process.env.BIGSET_BENCHMARK_REQUIRED_COLUMNS ?? "")
  .split(",")
  .map((columnName) => columnName.trim())
  .filter(Boolean);

const cells = Object.fromEntries(
  requiredColumns.map((columnName) => [
    columnName,
    valueForColumn({ columnName, prompt, promptId }),
  ])
);

const sourceUrl = `https://example.com/bigset-benchmark/${encodeURIComponent(promptId)}`;
cells.source_url = cells.source_url ?? sourceUrl;

console.log(
  JSON.stringify({
    rows: [
      {
        cells,
        sourceUrls: [sourceUrl],
        evidence: [
          {
            columnName: requiredColumns[0] ?? "entity_name",
            sourceUrl,
            quote: `Smoke benchmark evidence for ${promptId}`,
          },
        ],
        needsReview: false,
      },
    ],
    validationIssues: [],
    usage: {
      promptTokens: Math.max(1, Math.round(prompt.length / 4)),
      completionTokens: 120,
      totalTokens: Math.max(1, Math.round(prompt.length / 4)) + 120,
    },
    metrics: {
      searchCalls: 1,
      fetchCalls: 1,
      browserCalls: 0,
      agentRuns: 1,
      agentSteps: 3,
    },
  })
);

function valueForColumn({ columnName, prompt, promptId }) {
  if (columnName.endsWith("_url") || columnName === "source_url") {
    return `https://example.com/${encodeURIComponent(promptId)}`;
  }
  if (columnName.includes("date") || columnName.endsWith("_at")) {
    return "2026-05-19";
  }
  if (columnName.includes("price") || columnName.includes("count")) {
    return 1;
  }
  if (columnName.startsWith("is_") || columnName.startsWith("has_")) {
    return true;
  }
  return prompt.slice(0, 80) || promptId;
}
