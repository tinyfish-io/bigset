import {
  emptyMetrics,
  emptyUsage,
  minimumRequiredColumnsForRunInput,
  normalizeDatasetAgentResult,
} from "./output.js";
import type {
  DatasetRecipe,
  DatasetRecipeArtifact,
  DatasetRecipeBenchmarkScore,
  DatasetRecipeProductionValidation,
  DatasetRecipeRunInput,
  DatasetRecipeRunResult,
  DatasetRecipeRuntime,
  DatasetRecipeRunStatus,
} from "./recipe-types.js";
import type {
  DatasetAgentRunInput,
  DatasetAgentRunResult,
  DatasetAgentUsage,
  DatasetAgentMetrics,
} from "./types.js";

export interface FakeDatasetRecipeScenario {
  rawOutput?: unknown;
  usage?: Partial<DatasetAgentUsage>;
  metrics?: Partial<DatasetAgentMetrics>;
  artifacts?: DatasetRecipeArtifact[];
  benchmarkScore?: DatasetRecipeBenchmarkScore;
  runStatus?: DatasetRecipeRunStatus;
  startedAt?: string;
  completedAt?: string;
  runtimeMs?: number;
}

export class FakeDatasetRecipeRuntime implements DatasetRecipeRuntime {
  private readonly scenariosByRecipeId: Map<string, FakeDatasetRecipeScenario>;

  constructor(scenariosByRecipeId: Record<string, FakeDatasetRecipeScenario>) {
    this.scenariosByRecipeId = new Map(Object.entries(scenariosByRecipeId));
  }

  async runRecipe(input: DatasetRecipeRunInput): Promise<DatasetRecipeRunResult> {
    const scenario = this.scenariosByRecipeId.get(input.recipe.recipeId) ?? {};
    const startedAt = scenario.startedAt ?? new Date().toISOString();
    const completedAt = scenario.completedAt ?? startedAt;
    const normalizedResult = normalizeDatasetAgentResult({
      rawOutput: scenario.rawOutput ?? { rows: [], validationIssues: [] },
      runInput: input.runInput,
      usage: scenario.usage,
      metrics: scenario.metrics,
    });

    return createDatasetRecipeRunResult({
      recipe: input.recipe,
      runInput: input.runInput,
      result: normalizedResult,
      runStatus:
        scenario.runStatus ??
        (normalizedResult.validationIssues.length === 0 ? "succeeded" : "failed"),
      startedAt,
      completedAt,
      runtimeMs: scenario.runtimeMs ?? 0,
      artifacts: scenario.artifacts ?? [],
      benchmarkScore: scenario.benchmarkScore,
    });
  }
}

export function createDatasetRecipe(input: {
  recipeId: string;
  datasetId: string;
  version: number;
  scriptText: string;
  requestedColumns: string[];
  sourcePrompt: string;
  minimumRequiredColumns?: string[];
  status?: DatasetRecipe["status"];
  createdAt?: string;
  createdBy?: DatasetRecipe["createdBy"];
}): DatasetRecipe {
  const runInput = {
    prompt: input.sourcePrompt,
    requiredColumns: input.requestedColumns,
    minimumRequiredColumns: input.minimumRequiredColumns,
  };

  return {
    recipeId: input.recipeId,
    datasetId: input.datasetId,
    version: input.version,
    status: input.status ?? "candidate",
    scriptText: input.scriptText,
    requestedColumns: input.requestedColumns,
    minimumRequiredColumns: minimumRequiredColumnsForRunInput(runInput),
    sourcePrompt: input.sourcePrompt,
    createdAt: input.createdAt ?? new Date().toISOString(),
    createdBy: input.createdBy ?? "agent",
  };
}

export function createDatasetRecipeRunResult(input: {
  recipe: DatasetRecipe;
  runInput: DatasetAgentRunInput;
  result: DatasetAgentRunResult;
  runStatus: DatasetRecipeRunStatus;
  startedAt: string;
  completedAt: string;
  runtimeMs: number;
  artifacts: DatasetRecipeArtifact[];
  benchmarkScore?: DatasetRecipeBenchmarkScore;
}): DatasetRecipeRunResult {
  return {
    ...input.result,
    recipeId: input.recipe.recipeId,
    recipeVersion: input.recipe.version,
    runStatus: input.runStatus,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    runtimeMs: input.runtimeMs,
    artifacts: input.artifacts,
    productionValidation: evaluateRecipeProductionValidation({
      result: input.result,
      runInput: input.runInput,
    }),
    benchmarkScore: input.benchmarkScore,
  };
}

export function evaluateRecipeProductionValidation(input: {
  result: DatasetAgentRunResult;
  runInput: DatasetAgentRunInput;
}): DatasetRecipeProductionValidation {
  const minimumRequiredColumns = minimumRequiredColumnsForRunInput(input.runInput);
  const requestedColumns = input.runInput.requiredColumns;
  const rows = input.result.rows;
  const criticalIssues = new Set(input.result.validationIssues);
  let presentMinimumCellCount = 0;
  let presentRequestedCellCount = 0;
  let rowsWithSourceUrl = 0;
  let rowsWithEvidence = 0;

  if (rows.length === 0) {
    criticalIssues.add("No rows returned.");
  }

  for (const [rowIndex, row] of rows.entries()) {
    if (row.sourceUrls.length > 0) {
      rowsWithSourceUrl += 1;
    } else {
      criticalIssues.add(`Row ${rowIndex} has no source URL.`);
    }

    if (row.evidence.length > 0) {
      rowsWithEvidence += 1;
    } else {
      criticalIssues.add(`Row ${rowIndex} has no evidence quote.`);
    }

    for (const columnName of minimumRequiredColumns) {
      if (isPresent(row.cells[columnName])) {
        presentMinimumCellCount += 1;
      } else {
        criticalIssues.add(
          `Row ${rowIndex} missing minimum required column ${columnName}.`
        );
      }
    }

    for (const columnName of requestedColumns) {
      if (isPresent(row.cells[columnName])) {
        presentRequestedCellCount += 1;
      }
    }
  }

  const rowCount = rows.length;
  const minimumRequiredCompletenessRatio = ratio(
    presentMinimumCellCount,
    rowCount * minimumRequiredColumns.length
  );
  const requestedCellCompletenessRatio = ratio(
    presentRequestedCellCount,
    rowCount * requestedColumns.length
  );
  const sourceUrlCoverageRatio = coverageRatio(rowsWithSourceUrl, rowCount);
  const evidenceCoverageRatio = coverageRatio(rowsWithEvidence, rowCount);
  const score = roundRatio(
    ratio(rowCount, Math.max(rowCount, 1)) * 0.15 +
      minimumRequiredCompletenessRatio * 0.35 +
      sourceUrlCoverageRatio * 0.2 +
      evidenceCoverageRatio * 0.2 +
      requestedCellCompletenessRatio * 0.1
  );

  return {
    isValid:
      rowCount > 0 &&
      criticalIssues.size === 0 &&
      minimumRequiredCompletenessRatio === 1 &&
      sourceUrlCoverageRatio === 1 &&
      evidenceCoverageRatio === 1,
    score,
    rowCount,
    minimumRequiredCompletenessRatio,
    requestedCellCompletenessRatio,
    sourceUrlCoverageRatio,
    evidenceCoverageRatio,
    criticalIssues: Array.from(criticalIssues),
    warnings: completenessWarnings({
      requestedColumns,
      requestedCellCompletenessRatio,
    }),
  };
}

function completenessWarnings(input: {
  requestedColumns: string[];
  requestedCellCompletenessRatio: number;
}): string[] {
  if (
    input.requestedColumns.length === 0 ||
    input.requestedCellCompletenessRatio === 1
  ) {
    return [];
  }

  return [
    `Requested-cell completeness ${input.requestedCellCompletenessRatio} below 1.`,
  ];
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return roundRatio(numerator / denominator);
}

function coverageRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return ratio(numerator, denominator);
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function emptyRecipeRunResult(input: {
  recipe: DatasetRecipe;
  runInput: DatasetAgentRunInput;
  validationIssue: string;
}): DatasetRecipeRunResult {
  const result = normalizeDatasetAgentResult({
    rawOutput: {
      rows: [],
      validationIssues: [input.validationIssue],
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    },
    runInput: input.runInput,
  });

  return createDatasetRecipeRunResult({
    recipe: input.recipe,
    runInput: input.runInput,
    result,
    runStatus: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    runtimeMs: 0,
    artifacts: [],
  });
}
