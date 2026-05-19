import {
  emptyMetrics,
  normalizeDatasetAgentResult,
} from "./output.js";
import type {
  DatasetAgentRunInput,
  DatasetAgentRuntime,
} from "./types.js";

export class DeterministicDatasetAgentRuntime implements DatasetAgentRuntime {
  async runDatasetBuild(input: DatasetAgentRunInput) {
    const sourceUrl = `https://example.com/bigset/${encodeURIComponent(input.promptId ?? "dataset")}`;
    const cells = Object.fromEntries(
      input.requiredColumns.map((columnName) => [
        columnName,
        deterministicCellValue({ columnName, input, sourceUrl }),
      ])
    );

    return normalizeDatasetAgentResult({
      rawOutput: {
        rows: [
          {
            cells: {
              ...cells,
              source_url: cells.source_url ?? sourceUrl,
            },
            sourceUrls: [sourceUrl],
            evidence: [
              {
                columnName: input.requiredColumns[0] ?? "entity_name",
                sourceUrl,
                quote: `Deterministic oracle evidence for ${input.promptId ?? input.prompt.slice(0, 24)}`,
              },
            ],
          },
        ],
        validationIssues: [],
      },
      runInput: input,
      usage: {
        promptTokens: Math.max(1, Math.ceil(input.prompt.length / 4)),
        completionTokens: 96,
        totalTokens: Math.max(1, Math.ceil(input.prompt.length / 4)) + 96,
      },
      metrics: {
        ...emptyMetrics(),
        searchCalls: 1,
        fetchCalls: 1,
        agentRuns: 1,
        agentSteps: 1,
      },
    });
  }
}

function deterministicCellValue(input: {
  columnName: string;
  input: DatasetAgentRunInput;
  sourceUrl: string;
}) {
  if (input.columnName.endsWith("_url") || input.columnName === "source_url") {
    return input.sourceUrl;
  }
  if (input.columnName.includes("date") || input.columnName.endsWith("_at")) {
    return "2026-05-19";
  }
  if (
    input.columnName.includes("price") ||
    input.columnName.includes("count") ||
    input.columnName.includes("score")
  ) {
    return 1;
  }
  if (
    input.columnName.startsWith("is_") ||
    input.columnName.startsWith("has_") ||
    input.columnName.includes("serves") ||
    input.columnName.includes("stock")
  ) {
    return true;
  }
  return input.input.prompt.slice(0, 96) || input.input.promptId || "BigSet row";
}
