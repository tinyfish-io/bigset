import type {
  DatasetAgentCellValue,
  DatasetAgentEvidence,
  DatasetAgentMetrics,
  DatasetAgentRow,
  DatasetAgentRunInput,
  DatasetAgentRunResult,
  DatasetAgentUsage,
} from "./types.js";

export function emptyUsage(): DatasetAgentUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function emptyMetrics(): DatasetAgentMetrics {
  return {
    searchCalls: 0,
    fetchCalls: 0,
    browserCalls: 0,
    agentRuns: 0,
    agentSteps: 0,
  };
}

export function normalizeDatasetAgentResult(input: {
  rawOutput: unknown;
  runInput: DatasetAgentRunInput;
  usage?: Partial<DatasetAgentUsage>;
  metrics?: Partial<DatasetAgentMetrics>;
}): DatasetAgentRunResult {
  const outputRecord = isRecord(input.rawOutput) ? input.rawOutput : {};
  const rows = arrayValue(
    outputRecord.rows ??
      outputRecord.data ??
      outputRecord.records ??
      outputRecord.result
  ).map(normalizeRow);
  const validationIssues = [
    ...stringArrayValue(
      outputRecord.validationIssues ??
        outputRecord.issues ??
        outputRecord.errors
    ),
    ...validateRows({
      rows,
      requiredColumns: input.runInput.requiredColumns,
    }),
  ];

  return {
    rows,
    validationIssues: Array.from(new Set(validationIssues)),
    usage: {
      ...emptyUsage(),
      ...normalizeUsage(outputRecord.usage),
      ...input.usage,
    },
    metrics: {
      ...emptyMetrics(),
      ...normalizeMetrics(outputRecord.metrics),
      ...input.metrics,
    },
  };
}

export function parseOutputFromText(text: string): unknown {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return {};
  }

  try {
    return JSON.parse(trimmedText);
  } catch {
    const jsonObject = extractFirstJsonObject(trimmedText);
    return jsonObject ? JSON.parse(jsonObject) : {};
  }
}

function normalizeRow(row: unknown): DatasetAgentRow {
  const rowRecord = isRecord(row) ? row : {};
  const cells = normalizeCells(rowRecord.cells ?? rowRecord.data ?? rowRecord);
  const sourceUrls = normalizeSourceUrls(rowRecord, cells);

  return {
    cells,
    sourceUrls,
    evidence: normalizeEvidence(rowRecord, sourceUrls),
    needsReview: rowRecord.needsReview === true || rowRecord.needs_review === true,
  };
}

function normalizeCells(value: unknown): Record<string, DatasetAgentCellValue> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([columnName, cellValue]) => [
      columnName,
      normalizeCellValue(cellValue),
    ])
  );
}

function normalizeCellValue(value: unknown): DatasetAgentCellValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  if (isRecord(value)) {
    return value;
  }
  return null;
}

function normalizeSourceUrls(
  row: Record<string, unknown>,
  cells: Record<string, DatasetAgentCellValue>
): string[] {
  return Array.from(
    new Set(
      [
        ...stringArrayValue(row.sourceUrls),
        ...stringArrayValue(row.sources),
        ...stringArrayValue(row.source_urls),
        ...singleStringArray(row.sourceUrl),
        ...singleStringArray(row.source_url),
        ...singleStringArray(cells.source_url),
        ...singleStringArray(cells.sourceUrl),
      ].filter((sourceUrl) => /^https?:\/\//i.test(sourceUrl))
    )
  );
}

function normalizeEvidence(
  row: Record<string, unknown>,
  sourceUrls: string[]
): DatasetAgentEvidence[] {
  const rawEvidence = arrayValue(
    row.evidence ?? row.evidenceQuotes ?? row.evidence_quotes
  );

  return rawEvidence
    .map((item) => {
      if (typeof item === "string") {
        return {
          columnName: "entity_name",
          sourceUrl: sourceUrls[0] ?? "",
          quote: item,
        };
      }
      if (!isRecord(item)) {
        return null;
      }
      const columnName = stringValue(item.columnName) ?? "entity_name";
      const sourceUrl = stringValue(item.sourceUrl) ?? sourceUrls[0] ?? "";
      const quote = stringValue(item.quote);
      return quote ? { columnName, sourceUrl, quote } : null;
    })
    .filter(isNotNull);
}

function validateRows(input: {
  rows: DatasetAgentRow[];
  requiredColumns: string[];
}): string[] {
  const issues: string[] = [];
  if (input.rows.length === 0) {
    issues.push("No rows returned.");
  }

  for (const [rowIndex, row] of input.rows.entries()) {
    if (row.sourceUrls.length === 0) {
      issues.push(`Row ${rowIndex} has no source URL.`);
    }
    if (row.evidence.length === 0) {
      issues.push(`Row ${rowIndex} has no evidence quote.`);
    }
    for (const columnName of input.requiredColumns) {
      if (!isPresent(row.cells[columnName])) {
        issues.push(`Row ${rowIndex} missing required column ${columnName}.`);
      }
    }
  }

  return issues;
}

function normalizeUsage(value: unknown): DatasetAgentUsage {
  const usage = isRecord(value) ? value : {};
  const promptTokens = numberValue(
    usage.promptTokens ?? usage.inputTokens ?? usage.prompt_tokens
  );
  const completionTokens = numberValue(
    usage.completionTokens ?? usage.outputTokens ?? usage.completion_tokens
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      numberValue(usage.totalTokens ?? usage.total_tokens) ||
      promptTokens + completionTokens,
  };
}

function normalizeMetrics(value: unknown): DatasetAgentMetrics {
  const metrics = isRecord(value) ? value : {};
  return {
    searchCalls: numberValue(metrics.searchCalls ?? metrics.searchCallCount),
    fetchCalls: numberValue(metrics.fetchCalls ?? metrics.fetchCallCount),
    browserCalls: numberValue(metrics.browserCalls ?? metrics.browserCallCount),
    agentRuns: numberValue(metrics.agentRuns ?? metrics.agentRunCount),
    agentSteps: numberValue(metrics.agentSteps ?? metrics.agentStepCount),
  };
}

function extractFirstJsonObject(value: string): string | null {
  const firstBraceIndex = value.indexOf("{");
  if (firstBraceIndex === -1) {
    return null;
  }

  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;

  for (let index = firstBraceIndex; index < value.length; index += 1) {
    const character = value[index];
    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === "\"") {
        isInsideString = false;
      }
      continue;
    }
    if (character === "\"") {
      isInsideString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(firstBraceIndex, index + 1);
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function singleStringArray(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}
