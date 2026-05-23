import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type PopulateProcessTrace,
  type PopulateRuntimeAgentRunner,
  type PopulateRuntimeResult,
  type PopulateRuntimeRow,
  type PopulateRuntimeWebTools,
  runPopulateRuntime,
} from "./populate-runtime.js";
import {
  datasetContextSchema,
  type DatasetContext,
} from "./populate.js";
import {
  playwrightCandidateReadinessForRun,
  type PopulatePlaywrightCandidateReadiness,
} from "./populate-playwright-readiness.js";
import { playwrightCandidateScriptForRun } from "./populate-playwright-candidate-script.js";

export type PopulateRecipeStatus =
  | "active"
  | "candidate"
  | "retired"
  | "rejected";

export type PopulateRecipeRunStatus = "succeeded" | "failed";

export type PopulateRecipeArtifactKind =
  | "text"
  | "stderr"
  | "source-transcript"
  | "captured-rows"
  | "process-trace"
  | "playwright-candidate-readiness"
  | "playwright-candidate-script";

const MAX_ARTIFACT_TEXT_LENGTH = 20_000;
const PROCESS_TRACE_ARTIFACT_LIMITS = [
  { maxItems: 100, maxNestedItems: 25, maxStringLength: 500 },
  { maxItems: 50, maxNestedItems: 10, maxStringLength: 240 },
  { maxItems: 25, maxNestedItems: 8, maxStringLength: 120 },
  { maxItems: 10, maxNestedItems: 5, maxStringLength: 80 },
] as const;

export interface PopulateRecipe {
  recipeId: string;
  datasetId: string;
  version: number;
  status: PopulateRecipeStatus;
  runtimeInstructions: string;
  sourceDescription: string;
  requestedColumns: string[];
  createdAt: string;
  createdBy: "agent" | "human" | "system";
  lastSuccessfulRunAt?: string;
  lastValidationScore?: number;
}

export interface PopulateRecipeArtifact {
  kind: PopulateRecipeArtifactKind;
  label: string;
  content: string;
}

export interface PopulateRecipeProductionValidation {
  state: PopulateValidationState;
  isValid: boolean;
  score: number;
  rowCount: number;
  safeRowCount: number;
  requestedCellCompletenessRatio: number;
  sourceUrlCoverageRatio: number;
  evidenceCoverageRatio: number;
  expectedEntityCoverageRatio: number;
  expectedEntities: string[];
  missingExpectedEntities: string[];
  coveragePolicy: PopulateValidationCoveragePolicy;
  targetSource: string;
  criticalIssues: string[];
  warnings: string[];
}

export type PopulateValidationState =
  | "accepted_full"
  | "accepted_partial"
  | "rejected";

export type PopulateValidationCoveragePolicy =
  | "partial_allowed"
  | "full_required";

interface PopulateValidationIntent {
  expectedEntities: string[];
  coveragePolicy: PopulateValidationCoveragePolicy;
  targetSource: string;
}

export interface PopulateRecipeRunResult extends PopulateRuntimeResult {
  recipeId: string;
  recipeVersion: number;
  runStatus: PopulateRecipeRunStatus;
  startedAt: string;
  completedAt: string;
  runtimeMs: number;
  productionValidation: PopulateRecipeProductionValidation;
  artifacts: PopulateRecipeArtifact[];
}

export interface PopulateRecipeRuntime {
  runRecipe(input: {
    recipe: PopulateRecipe;
    context: DatasetContext;
  }): Promise<PopulateRecipeRunResult>;
}

export interface PopulateRecipeAuthorGenerateInput {
  context: DatasetContext;
  nextVersion: number;
}

export interface PopulateRecipeAuthorRepairInput
  extends PopulateRecipeAuthorGenerateInput {
  activeRecipe: PopulateRecipe;
  failedRun: PopulateRecipeRunResult;
}

export interface PopulateRecipeAuthor {
  generateRecipe(input: PopulateRecipeAuthorGenerateInput): Promise<PopulateRecipe>;
  repairRecipe(input: PopulateRecipeAuthorRepairInput): Promise<PopulateRecipe>;
}

export interface StoredPopulateRecipeRunRecord {
  recipeId: string;
  recipeVersion: number;
  runStatus: PopulateRecipeRunStatus;
  completedAt: string;
  productionValidation: PopulateRecipeProductionValidation;
  artifacts: PopulateRecipeArtifact[];
}

export interface PopulateRecipeStoreSnapshot {
  datasetId: string;
  recipes: PopulateRecipe[];
  runRecords: StoredPopulateRecipeRunRecord[];
}

export interface PopulateRecipeStore {
  loadSnapshot(datasetId: string): Promise<PopulateRecipeStoreSnapshot>;
  saveRecipe(recipe: PopulateRecipe): Promise<void>;
  saveRunResult(datasetId: string, runResult: PopulateRecipeRunResult): Promise<void>;
  getActiveRecipe(datasetId: string): Promise<PopulateRecipe | undefined>;
}

export type SelfHealingPopulateAction =
  | "active_rerun_succeeded"
  | "generated_initial_recipe"
  | "repaired_active_recipe"
  | "candidate_rejected";

export interface SelfHealingPopulateTickResult {
  datasetId: string;
  action: SelfHealingPopulateAction;
  activeRecipe?: PopulateRecipe;
  candidateRecipe?: PopulateRecipe;
  activeRun?: PopulateRecipeRunResult;
  candidateRun?: PopulateRecipeRunResult;
  rejectionReasons: string[];
}

export class MastraPopulateRecipeRuntime implements PopulateRecipeRuntime {
  constructor(
    private readonly input: {
      runPopulate?: typeof runPopulateRuntime;
      webTools?: PopulateRuntimeWebTools;
      agentRunner?: PopulateRuntimeAgentRunner;
      maxRows?: number;
    } = {}
  ) {}

  async runRecipe(input: {
    recipe: PopulateRecipe;
    context: DatasetContext;
  }): Promise<PopulateRecipeRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const runtime = this.input.runPopulate ?? runPopulateRuntime;
    const context = contextWithRecipeInstructions(input.context, input.recipe);
    let result: PopulateRuntimeResult;
    let failureMessage: string | undefined;

    try {
      result = await runtime({
        context,
        webTools: this.input.webTools,
        agentRunner: this.input.agentRunner,
        maxRows: this.input.maxRows,
      });
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
      result = emptyPopulateRuntimeResult([failureMessage]);
    }

    return populateRecipeRunResultFromRuntimeResult({
      recipe: input.recipe,
      context: input.context,
      result,
      failureMessage,
      startedAt,
      startedAtMs,
    });
  }
}

export function populateRecipeRunResultFromRuntimeResult(input: {
  recipe: PopulateRecipe;
  context: DatasetContext;
  result: PopulateRuntimeResult;
  failureMessage?: string;
  startedAt: string;
  startedAtMs: number;
}): PopulateRecipeRunResult {
  const productionValidation = validatePopulateRuntimeResult({
    result: input.result,
    context: input.context,
  });
  const artifacts = artifactsForRun({
    result: input.result,
    failureMessage: input.failureMessage,
    validationIssues: input.result.validationIssues,
    productionValidation,
  });
  const completedAt = new Date().toISOString();

  return {
    ...input.result,
    recipeId: input.recipe.recipeId,
    recipeVersion: input.recipe.version,
    runStatus: productionValidation.state === "rejected" ? "failed" : "succeeded",
    startedAt: input.startedAt,
    completedAt,
    runtimeMs: Date.now() - input.startedAtMs,
    productionValidation,
    artifacts,
  };
}

export class DefaultPopulateRecipeAuthor implements PopulateRecipeAuthor {
  async generateRecipe(
    input: PopulateRecipeAuthorGenerateInput
  ): Promise<PopulateRecipe> {
    return createPopulateRecipe({
      recipeId: populateRecipeId(input.context.datasetId, input.nextVersion),
      datasetId: input.context.datasetId,
      version: input.nextVersion,
      sourceDescription: input.context.description,
      requestedColumns: requestedColumnNames(input.context),
      runtimeInstructions: initialRuntimeInstructions(input.context),
      createdBy: "system",
    });
  }

  async repairRecipe(
    input: PopulateRecipeAuthorRepairInput
  ): Promise<PopulateRecipe> {
    return createPopulateRecipe({
      recipeId: populateRecipeId(input.context.datasetId, input.nextVersion),
      datasetId: input.context.datasetId,
      version: input.nextVersion,
      sourceDescription: input.context.description,
      requestedColumns: requestedColumnNames(input.context),
      runtimeInstructions: repairRuntimeInstructions(input),
      createdBy: "system",
    });
  }
}

export class SelfHealingPopulateRecipeService {
  constructor(
    private readonly input: {
      store: PopulateRecipeStore;
      runtime: PopulateRecipeRuntime;
      author: PopulateRecipeAuthor;
    }
  ) {}

  async tick(input: {
    datasetId: string;
    context: DatasetContext;
  }): Promise<SelfHealingPopulateTickResult> {
    const context = {
      ...datasetContextSchema.parse(input.context),
      datasetId: input.datasetId,
    };
    const activeRecipe = await this.input.store.getActiveRecipe(input.datasetId);

    if (!activeRecipe) {
      return this.generateInitialRecipe({ datasetId: input.datasetId, context });
    }

    const activeRun = await this.input.runtime.runRecipe({
      recipe: activeRecipe,
      context,
    });
    await this.input.store.saveRunResult(input.datasetId, activeRun);

    if (isHealthyRun(activeRun)) {
      const updatedRecipe = successfulRecipe(activeRecipe, activeRun);
      await this.input.store.saveRecipe(updatedRecipe);
      return {
        datasetId: input.datasetId,
        action: "active_rerun_succeeded",
        activeRecipe: updatedRecipe,
        activeRun,
        rejectionReasons: [],
      };
    }

    const nextVersion = await this.nextVersion(input.datasetId);
    const candidateRecipe = normalizeCandidateRecipe({
      recipe: await this.input.author.repairRecipe({
        context,
        activeRecipe,
        failedRun: activeRun,
        nextVersion,
      }),
      datasetId: input.datasetId,
      context,
      version: nextVersion,
    });
    const candidateRun = await this.runCandidate({
      recipe: candidateRecipe,
      context,
      datasetId: input.datasetId,
    });

    if (shouldPromoteCandidate({ activeRecipe, activeRun, candidateRun })) {
      const retiredRecipe = { ...activeRecipe, status: "retired" as const };
      const promotedRecipe = successfulRecipe(candidateRecipe, candidateRun);
      await this.input.store.saveRecipe(retiredRecipe);
      await this.input.store.saveRecipe(promotedRecipe);
      return {
        datasetId: input.datasetId,
        action: "repaired_active_recipe",
        activeRecipe: promotedRecipe,
        candidateRecipe,
        activeRun,
        candidateRun,
        rejectionReasons: [],
      };
    }

    const rejectedRecipe = { ...candidateRecipe, status: "rejected" as const };
    await this.input.store.saveRecipe(rejectedRecipe);
    return {
      datasetId: input.datasetId,
      action: "candidate_rejected",
      activeRecipe,
      candidateRecipe: rejectedRecipe,
      activeRun,
      candidateRun,
      rejectionReasons: rejectionReasonsForCandidate({
        activeRecipe,
        activeRun,
        candidateRun,
      }),
    };
  }

  private async generateInitialRecipe(input: {
    datasetId: string;
    context: DatasetContext;
  }): Promise<SelfHealingPopulateTickResult> {
    const nextVersion = await this.nextVersion(input.datasetId);
    const candidateRecipe = normalizeCandidateRecipe({
      recipe: await this.input.author.generateRecipe({
        context: input.context,
        nextVersion,
      }),
      datasetId: input.datasetId,
      context: input.context,
      version: nextVersion,
    });
    const candidateRun = await this.runCandidate({
      recipe: candidateRecipe,
      context: input.context,
      datasetId: input.datasetId,
    });

    if (candidateRun.productionValidation.isValid) {
      const activeRecipe = successfulRecipe(candidateRecipe, candidateRun);
      await this.input.store.saveRecipe(activeRecipe);
      return {
        datasetId: input.datasetId,
        action: "generated_initial_recipe",
        activeRecipe,
        candidateRecipe,
        candidateRun,
        rejectionReasons: [],
      };
    }

    const rejectedRecipe = { ...candidateRecipe, status: "rejected" as const };
    await this.input.store.saveRecipe(rejectedRecipe);
    return {
      datasetId: input.datasetId,
      action: "candidate_rejected",
      candidateRecipe: rejectedRecipe,
      candidateRun,
      rejectionReasons: candidateRun.productionValidation.criticalIssues,
    };
  }

  private async runCandidate(input: {
    recipe: PopulateRecipe;
    context: DatasetContext;
    datasetId: string;
  }): Promise<PopulateRecipeRunResult> {
    await this.input.store.saveRecipe(input.recipe);
    const runResult = await this.input.runtime.runRecipe({
      recipe: input.recipe,
      context: input.context,
    });
    await this.input.store.saveRunResult(input.datasetId, runResult);
    return runResult;
  }

  private async nextVersion(datasetId: string): Promise<number> {
    const snapshot = await this.input.store.loadSnapshot(datasetId);
    return snapshot.recipes.reduce(
      (version, recipe) => Math.max(version, recipe.version),
      0
    ) + 1;
  }
}

export class InMemoryPopulateRecipeStore implements PopulateRecipeStore {
  private readonly snapshotsByDatasetId = new Map<string, PopulateRecipeStoreSnapshot>();

  async loadSnapshot(datasetId: string): Promise<PopulateRecipeStoreSnapshot> {
    return this.snapshotFor(datasetId);
  }

  async saveRecipe(recipe: PopulateRecipe): Promise<void> {
    const snapshot = this.snapshotFor(recipe.datasetId);
    const existingIndex = snapshot.recipes.findIndex(
      (storedRecipe) => storedRecipe.recipeId === recipe.recipeId
    );
    if (existingIndex >= 0) {
      snapshot.recipes[existingIndex] = recipe;
    } else {
      snapshot.recipes.push(recipe);
    }
    snapshot.recipes.sort((left, right) => left.version - right.version);
  }

  async saveRunResult(
    datasetId: string,
    runResult: PopulateRecipeRunResult
  ): Promise<void> {
    this.snapshotFor(datasetId).runRecords.push(runRecordFromRunResult(runResult));
  }

  async getActiveRecipe(datasetId: string): Promise<PopulateRecipe | undefined> {
    const snapshot = this.snapshotFor(datasetId);
    return snapshot.recipes
      .filter((recipe) => recipe.status === "active")
      .sort((left, right) => right.version - left.version)[0];
  }

  private snapshotFor(datasetId: string): PopulateRecipeStoreSnapshot {
    let snapshot = this.snapshotsByDatasetId.get(datasetId);
    if (!snapshot) {
      snapshot = { datasetId, recipes: [], runRecords: [] };
      this.snapshotsByDatasetId.set(datasetId, snapshot);
    }
    return snapshot;
  }
}

export class FileSystemPopulateRecipeStore implements PopulateRecipeStore {
  constructor(private readonly rootDirectory: string) {}

  async loadSnapshot(datasetId: string): Promise<PopulateRecipeStoreSnapshot> {
    try {
      const manifestText = await readFile(this.manifestPath(datasetId), "utf8");
      const parsed = JSON.parse(manifestText) as PopulateRecipeStoreSnapshot;
      return {
        datasetId,
        recipes: parsed.recipes ?? [],
        runRecords: (parsed.runRecords ?? []).map((record) => ({
          ...record,
          artifacts: record.artifacts ?? [],
        })),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { datasetId, recipes: [], runRecords: [] };
      }
      throw error;
    }
  }

  async saveRecipe(recipe: PopulateRecipe): Promise<void> {
    const snapshot = await this.loadSnapshot(recipe.datasetId);
    const existingIndex = snapshot.recipes.findIndex(
      (storedRecipe) => storedRecipe.recipeId === recipe.recipeId
    );
    if (existingIndex >= 0) {
      snapshot.recipes[existingIndex] = recipe;
    } else {
      snapshot.recipes.push(recipe);
    }
    snapshot.recipes.sort((left, right) => left.version - right.version);
    await this.writeSnapshot(snapshot);
  }

  async saveRunResult(
    datasetId: string,
    runResult: PopulateRecipeRunResult
  ): Promise<void> {
    const snapshot = await this.loadSnapshot(datasetId);
    snapshot.runRecords.push(runRecordFromRunResult(runResult));
    await this.writeSnapshot(snapshot);
  }

  async getActiveRecipe(datasetId: string): Promise<PopulateRecipe | undefined> {
    const snapshot = await this.loadSnapshot(datasetId);
    return snapshot.recipes
      .filter((recipe) => recipe.status === "active")
      .sort((left, right) => right.version - left.version)[0];
  }

  private async writeSnapshot(snapshot: PopulateRecipeStoreSnapshot): Promise<void> {
    await mkdir(this.datasetDirectory(snapshot.datasetId), { recursive: true });
    await writeFile(
      this.manifestPath(snapshot.datasetId),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8"
    );
  }

  private datasetDirectory(datasetId: string): string {
    return join(this.rootDirectory, safePathSegment(datasetId));
  }

  private manifestPath(datasetId: string): string {
    return join(this.datasetDirectory(datasetId), "manifest.json");
  }
}

export function createPopulateRecipe(input: {
  recipeId: string;
  datasetId: string;
  version: number;
  sourceDescription: string;
  requestedColumns: string[];
  runtimeInstructions?: string;
  status?: PopulateRecipeStatus;
  createdAt?: string;
  createdBy?: PopulateRecipe["createdBy"];
}): PopulateRecipe {
  return {
    recipeId: input.recipeId,
    datasetId: input.datasetId,
    version: input.version,
    status: input.status ?? "candidate",
    runtimeInstructions: input.runtimeInstructions ?? "",
    sourceDescription: input.sourceDescription,
    requestedColumns: input.requestedColumns,
    createdAt: input.createdAt ?? new Date().toISOString(),
    createdBy: input.createdBy ?? "agent",
  };
}

function normalizeCandidateRecipe(input: {
  recipe: PopulateRecipe;
  datasetId: string;
  context: DatasetContext;
  version: number;
}): PopulateRecipe {
  return {
    ...input.recipe,
    datasetId: input.datasetId,
    version: input.version,
    status: "candidate",
    sourceDescription: input.context.description,
    requestedColumns: input.context.columns.map((column) => column.name),
  };
}

function populateRecipeId(datasetId: string, version: number): string {
  return `${safePathSegment(datasetId)}-recipe-v${version}`;
}

function requestedColumnNames(context: DatasetContext): string[] {
  return context.columns.map((column) => column.name);
}

function requiredColumnNamesForValidation(context: DatasetContext): string[] {
  return context.columns
    .filter((column) => column.nullable !== true)
    .map((column) => column.name);
}

function columnRequirementLabels(context: DatasetContext): string {
  return context.columns
    .map((column) => `${column.name}${column.nullable ? " (nullable)" : " (required)"}`)
    .join(", ");
}

function initialRuntimeInstructions(context: DatasetContext): string {
  return [
    "Use search_web before fetch_page unless an official source URL is already obvious.",
    "Prefer official docs, pricing, blog, product, or company pages over third-party summaries.",
    "Every inserted row must include source_url and evidence_quote cells when those columns exist.",
    "Every inserted row must include at least one source URL and one evidence quote.",
    `Requested columns: ${columnRequirementLabels(context)}.`,
  ].join("\n");
}

function repairRuntimeInstructions(input: PopulateRecipeAuthorRepairInput): string {
  const failureSummary = [
    ...input.failedRun.productionValidation.criticalIssues,
    ...input.failedRun.validationIssues,
  ]
    .map((issue) => issue.trim())
    .filter(Boolean)
    .slice(0, 8);
  const priorInstructions = input.activeRecipe.runtimeInstructions.trim();
  return [
    priorInstructions || initialRuntimeInstructions(input.context),
    "",
    "Repair focus from previous failed run:",
    ...failureSummary.map((issue) => `- ${truncateInstruction(issue, 240)}`),
    "- Do not reuse rows that failed validation without fixing source URL and evidence quote coverage.",
    "- If expected entities were missing, collect one source-backed row per missing entity before returning.",
  ].join("\n");
}

function truncateInstruction(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 12)} [truncated]`;
}

function contextWithRecipeInstructions(
  context: DatasetContext,
  recipe: PopulateRecipe
): DatasetContext {
  if (!recipe.runtimeInstructions.trim()) {
    return context;
  }
  return {
    ...context,
    description: [
      context.description,
      "",
      "Durable recipe instructions:",
      recipe.runtimeInstructions.trim(),
    ].join("\n"),
  };
}

function validatePopulateRuntimeResult(input: {
  result: PopulateRuntimeResult;
  context: DatasetContext;
}): PopulateRecipeProductionValidation {
  const requestedColumns = requestedColumnNames(input.context);
  const requiredColumns = requiredColumnNamesForValidation(input.context);
  const nullableColumns = requestedColumns.filter(
    (columnName) => !requiredColumns.includes(columnName)
  );
  const validationIntent = validationIntentFromContext(input.context);
  const expectedEntities = validationIntent.expectedEntities;
  const entityCoverage = expectedEntityCoverage({
    rows: input.result.rows,
    expectedEntities,
  });
  const rowCount = input.result.rows.length;
  const rowSafety = input.result.rows.map((row, index) =>
    productionRowSafety({
      row,
      rowNumber: index + 1,
      requiredColumns,
    })
  );
  const rowCriticalIssues = rowSafety.flatMap((safety) => safety.criticalIssues);
  const dataCriticalIssues = criticalValidationIssues({
    validationIssues: input.result.validationIssues,
    nullableColumns,
    requiredColumns,
  });
  const coverageIssues = coverageIssuesFromValidationIntent({
    missingExpectedEntities: entityCoverage.missingExpectedEntities,
  });
  const safeRowCount = rowSafety.filter((safety) => safety.isSafe).length;
  const state = validationStateFromSignals({
    rowCount,
    safeRowCount,
    rowCriticalIssues,
    dataCriticalIssues,
    coverageIssues,
    coveragePolicy: validationIntent.coveragePolicy,
  });
  const requestedCellCompletenessRatio = averageRatio(
    input.result.rows.map((row) => cellCompletenessRatio(row, requestedColumns))
  );
  const sourceUrlCoverageRatio = averageRatio(
    input.result.rows.map((row) => row.sourceUrls.length > 0 ? 1 : 0)
  );
  const evidenceCoverageRatio = averageRatio(
    input.result.rows.map((row) => row.evidence.length > 0 ? 1 : 0)
  );
  const scoreComponents = [
    requestedCellCompletenessRatio,
    sourceUrlCoverageRatio,
    evidenceCoverageRatio,
  ];
  if (expectedEntities.length > 0) {
    scoreComponents.push(entityCoverage.expectedEntityCoverageRatio);
  }
  const score = rowCount === 0
    ? 0
    : averageRatio(scoreComponents);
  const criticalIssues = Array.from(new Set([
    ...rowCriticalIssues,
    ...dataCriticalIssues,
    ...coverageIssues,
  ]));

  return {
    state,
    isValid: state === "accepted_full",
    score,
    rowCount,
    safeRowCount,
    requestedCellCompletenessRatio,
    sourceUrlCoverageRatio,
    evidenceCoverageRatio,
    expectedEntityCoverageRatio: entityCoverage.expectedEntityCoverageRatio,
    expectedEntities,
    missingExpectedEntities: entityCoverage.missingExpectedEntities,
    coveragePolicy: validationIntent.coveragePolicy,
    targetSource: validationIntent.targetSource,
    criticalIssues,
    warnings: input.result.validationIssues,
  };
}

function validationStateFromSignals(input: {
  rowCount: number;
  safeRowCount: number;
  rowCriticalIssues: string[];
  dataCriticalIssues: string[];
  coverageIssues: string[];
  coveragePolicy: PopulateValidationCoveragePolicy;
}): PopulateValidationState {
  if (input.rowCount === 0 || input.safeRowCount === 0) {
    return "rejected";
  }
  if (input.rowCriticalIssues.length > 0 || input.dataCriticalIssues.length > 0) {
    return "rejected";
  }
  if (input.coverageIssues.length > 0) {
    return input.coveragePolicy === "partial_allowed"
      ? "accepted_partial"
      : "rejected";
  }
  return "accepted_full";
}

function coverageIssuesFromValidationIntent(input: {
  missingExpectedEntities: string[];
}): string[] {
  if (input.missingExpectedEntities.length === 0) {
    return [];
  }
  return [
    `Missing expected entities: ${input.missingExpectedEntities.join(", ")}.`,
  ];
}

function productionRowSafety(input: {
  row: PopulateRuntimeRow;
  rowNumber: number;
  requiredColumns: string[];
}): {
  isSafe: boolean;
  criticalIssues: string[];
} {
  const criticalIssues: string[] = [];
  const missingColumns = input.requiredColumns.filter(
    (columnName) => isMissingCellValue(input.row.cells[columnName])
  );
  if (missingColumns.length > 0) {
    criticalIssues.push(
      `Row ${input.rowNumber} missing requested columns: ${missingColumns.join(", ")}.`
    );
  }
  if (input.row.sourceUrls.length === 0) {
    criticalIssues.push(`Row ${input.rowNumber} has no source URL.`);
  }
  if (input.row.sourceUrls.some((sourceUrl) => !isHttpUrl(sourceUrl))) {
    criticalIssues.push(`Row ${input.rowNumber} has an invalid source URL.`);
  }
  if (input.row.evidence.length === 0) {
    criticalIssues.push(`Row ${input.rowNumber} has no evidence quote.`);
  }
  if (input.row.evidence.some((item) => !item.quote.trim())) {
    criticalIssues.push(`Row ${input.rowNumber} has a blank evidence quote.`);
  }
  if (
    input.row.evidence.some((item) => !input.row.sourceUrls.includes(item.sourceUrl))
  ) {
    criticalIssues.push(
      `Row ${input.rowNumber} has evidence that does not match a row source URL.`
    );
  }
  return {
    isSafe: criticalIssues.length === 0,
    criticalIssues,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function criticalValidationIssues(input: {
  validationIssues: string[];
  nullableColumns: string[];
  requiredColumns: string[];
}): string[] {
  return input.validationIssues.filter((issue) =>
    /failed|missing|no rows|not found|invented|invalid|approximation|manual review|not present|could not be determined|left blank|unavailable/i.test(issue) &&
    !isNullableColumnOnlyWarning(issue, {
      nullableColumns: input.nullableColumns,
      requiredColumns: input.requiredColumns,
    }) &&
    !isNonBlockingOperationalWarning(issue)
  );
}

export function safeRowsForPopulateCommit(input: {
  context: DatasetContext;
  run: PopulateRecipeRunResult;
}): PopulateRuntimeRow[] {
  const context = datasetContextSchema.parse(input.context);
  const requiredColumns = requiredColumnNamesForValidation(context);
  return input.run.rows.filter((row, index) =>
    productionRowSafety({
      row,
      rowNumber: index + 1,
      requiredColumns,
    }).isSafe
  );
}

function isNullableColumnOnlyWarning(
  issue: string,
  input: {
    nullableColumns: string[];
    requiredColumns: string[];
  }
): boolean {
  if (!/not present|could not be determined|left blank|unavailable/i.test(issue)) {
    return false;
  }
  const mentionsNullableColumn = input.nullableColumns.some((columnName) =>
    issueMentionsColumn(issue, columnName)
  );
  if (!mentionsNullableColumn) {
    return false;
  }
  return !input.requiredColumns.some((columnName) =>
    issueMentionsColumn(issue, columnName)
  );
}

function issueMentionsColumn(issue: string, columnName: string): boolean {
  const normalizedIssue = normalizeColumnMention(issue);
  const normalizedColumnName = normalizeColumnMention(columnName);
  const meaningfulTokens = columnName
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .filter((part) =>
      !["source", "url", "link", "evidence", "quote", "field", "value"].includes(part)
    );
  if (meaningfulTokens.length === 0) {
    return normalizedIssue.includes(normalizedColumnName);
  }
  return meaningfulTokens.some((part) =>
    normalizedIssue.includes(part.replace(/s$/, ""))
  );
}

function normalizeColumnMention(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function cellCompletenessRatio(
  row: PopulateRuntimeRow,
  requestedColumns: string[]
): number {
  if (requestedColumns.length === 0) {
    return 1;
  }
  const filledCount = requestedColumns.filter(
    (columnName) => !isMissingCellValue(row.cells[columnName])
  ).length;
  return filledCount / requestedColumns.length;
}

function validationIntentFromContext(context: DatasetContext): PopulateValidationIntent {
  return {
    expectedEntities: expectedEntitiesFromContext(context),
    coveragePolicy: coveragePolicyFromContext(context),
    targetSource: targetSourceFromContext(context),
  };
}

function expectedEntitiesFromContext(context: DatasetContext): string[] {
  const description = context.description.replace(/\s+/g, " ").trim();
  const entitySegments = [
    ...entitySegmentsAfterConnectors(description),
    capitalizedListSegment(description),
  ].filter((segment): segment is string => Boolean(segment));
  const entities = entitySegments
    .flatMap((segment) => entitiesFromSegment(segment))
    .filter((entity) =>
      entity.length >= 2 &&
      entity.length <= 60 &&
      /[A-Z]/.test(entity)
    );
  return entities.length >= 2 ? Array.from(new Set(entities)) : [];
}

function entitySegmentsAfterConnectors(description: string): string[] {
  return Array.from(
    description.matchAll(
      /\b(?:from|for|across|among|between)\s+([^?.]+)/gi
    )
  ).map((match) => stopEntitySegment(match[1] ?? ""));
}

function capitalizedListSegment(description: string): string | undefined {
  const commaList = description.match(
    /\b([A-Z][A-Za-z0-9.&-]*(?:\s+[A-Z][A-Za-z0-9.&-]*)?(?:\s*,\s*[A-Z][A-Za-z0-9.&-]*(?:\s+[A-Z][A-Za-z0-9.&-]*)?)+(?:,?\s+and\s+[A-Z][A-Za-z0-9.&-]*(?:\s+[A-Z][A-Za-z0-9.&-]*)?)?)\b/
  )?.[1];
  return commaList ? stopEntitySegment(commaList) : undefined;
}

function stopEntitySegment(segment: string): string {
  return segment
    .split(/\b(?:include|includes|including|with|where|that|whose|prefer|using|one row|one record|as|by)\b/i)[0]
    ?.trim() ?? "";
}

function entitiesFromSegment(segment: string): string[] {
  return segment
    .split(/,|\band\b/i)
    .map((entity) => entity.replace(/\b(the|a|an)\b/gi, " ").trim())
    .map((entity) => entity.replace(/\s+/g, " "))
    .map((entity) => entity.replace(/[.:;]+$/g, "").trim())
    .filter((entity) => !isValidationIntentStopword(entity));
}

function isValidationIntentStopword(value: string): boolean {
  return /^(create|dataset|current|public|api|model|pricing|latest|posts?|articles?|companies|sources?|official|pages?)$/i.test(value);
}

function coveragePolicyFromContext(
  context: DatasetContext
): PopulateValidationCoveragePolicy {
  return /\b(no partial|full coverage|required coverage|must include all|every expected|all expected)\b/i.test(
    context.description
  )
    ? "full_required"
    : "partial_allowed";
}

function targetSourceFromContext(context: DatasetContext): string {
  if (/\bofficial\b/i.test(context.description)) {
    return "official public pages";
  }
  if (/\b(public|website|docs|blog|news|pricing)\b/i.test(context.description)) {
    return "public web sources";
  }
  return "source-backed public data";
}

function expectedEntityCoverage(input: {
  rows: PopulateRuntimeRow[];
  expectedEntities: string[];
}): {
  expectedEntityCoverageRatio: number;
  missingExpectedEntities: string[];
} {
  if (input.expectedEntities.length === 0) {
    return {
      expectedEntityCoverageRatio: 1,
      missingExpectedEntities: [],
    };
  }
  const missingExpectedEntities = input.expectedEntities.filter(
    (entity) => !input.rows.some((row) =>
      rowIdentityText(row).includes(entity.toLowerCase())
    )
  );
  return {
    expectedEntityCoverageRatio: roundScore(
      (input.expectedEntities.length - missingExpectedEntities.length) /
      input.expectedEntities.length
    ),
    missingExpectedEntities,
  };
}

function rowIdentityText(row: PopulateRuntimeRow): string {
  return [
    row.cells.entity_name,
    row.cells.company_name,
    row.cells.provider_name,
    row.cells.product_name,
    row.cells.name,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
    .toLowerCase();
}

function isNonBlockingOperationalWarning(issue: string): boolean {
  return /^(Structured fallback (search|fetch) failed|search_web failed|fetch_page failed|context URL fetch failed)/i.test(issue);
}

function isMissingCellValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function averageRatio(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return roundScore(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function artifactsForRun(input: {
  result: PopulateRuntimeResult;
  failureMessage?: string;
  validationIssues: string[];
  productionValidation: PopulateRecipeProductionValidation;
}): PopulateRecipeArtifact[] {
  const artifacts: PopulateRecipeArtifact[] = [];
  const debugNotes = input.result.debug?.notes ?? [];
  if (input.failureMessage) {
    artifacts.push({
      kind: "stderr",
      label: "populate-runtime-error",
      content: input.failureMessage,
    });
  }
  if (input.validationIssues.length > 0 || input.productionValidation.criticalIssues.length > 0) {
    artifacts.push({
      kind: "text",
      label: "populate-validation",
      content: [
        ...input.validationIssues,
        ...input.productionValidation.criticalIssues,
      ].join("\n"),
    });
  }
  if (debugNotes.length > 0) {
    artifacts.push({
      kind: "text",
      label: "populate-debug-notes",
      content: debugNotes.join("\n").slice(0, MAX_ARTIFACT_TEXT_LENGTH),
    });
  }
  const capturedSources = input.result.debug?.capturedSources ?? [];
  const capturedRows = input.result.debug?.capturedRows ?? [];
  const processTrace = input.result.debug?.processTrace ?? {
    runtime: "unknown",
    searchQueries: [],
    fetchedUrls: [],
    sourceArtifacts: [],
    selectedRowSource: "none",
    notes: [],
    steps: [],
  };
  if (capturedSources.length > 0) {
    artifacts.push({
      kind: "source-transcript",
      label: "populate-source-transcript",
      content: capturedSources
        .map((source, index) => [
          `SOURCE ${index + 1}`,
          `URL: ${source.url}`,
          "TEXT:",
          source.text,
        ].join("\n"))
        .join("\n\n")
        .slice(0, MAX_ARTIFACT_TEXT_LENGTH),
    });
  }
  if (capturedRows.length > 0) {
    artifacts.push({
      kind: "captured-rows",
      label: "populate-captured-rows",
      content: JSON.stringify(capturedRows, null, 2)
        .slice(0, MAX_ARTIFACT_TEXT_LENGTH),
    });
  }
  if (
    processTrace.steps.length > 0 ||
    processTrace.searchQueries.length > 0 ||
    processTrace.fetchedUrls.length > 0 ||
    processTrace.sourceArtifacts.length > 0
  ) {
    const playwrightCandidateScript = playwrightCandidateScriptForRun({
      result: input.result,
    });
    artifacts.push({
      kind: "process-trace",
      label: "populate-process-trace",
      content: processTraceArtifactContent(processTrace),
    });
    artifacts.push({
      kind: "playwright-candidate-readiness",
      label: "populate-playwright-candidate-readiness",
      content: playwrightCandidateReadinessArtifactContent(
        playwrightCandidateReadinessForRun({ result: input.result })
      ),
    });
    if (
      playwrightCandidateScript &&
      playwrightCandidateScript.length <= MAX_ARTIFACT_TEXT_LENGTH
    ) {
      artifacts.push({
        kind: "playwright-candidate-script",
        label: "populate-playwright-candidate-script",
        content: playwrightCandidateScript,
      });
    }
  }
  return artifacts;
}

function playwrightCandidateReadinessArtifactContent(
  readiness: PopulatePlaywrightCandidateReadiness
): string {
  return JSON.stringify(readiness, null, 2)
    .slice(0, MAX_ARTIFACT_TEXT_LENGTH);
}

function processTraceArtifactContent(processTrace: PopulateProcessTrace): string {
  let content = "";
  for (const limits of PROCESS_TRACE_ARTIFACT_LIMITS) {
    content = JSON.stringify(truncatedProcessTrace(processTrace, limits), null, 2);
    if (content.length <= MAX_ARTIFACT_TEXT_LENGTH) {
      return content;
    }
  }
  return content;
}

function truncatedProcessTrace(
  processTrace: PopulateProcessTrace,
  limits: typeof PROCESS_TRACE_ARTIFACT_LIMITS[number]
) {
  return {
    ...processTrace,
    truncated: hasProcessTraceOverflow(processTrace, limits),
    searchQueries: processTrace.searchQueries
      .slice(0, limits.maxItems)
      .map((query) => truncateArtifactString(query, limits)),
    fetchedUrls: processTrace.fetchedUrls
      .slice(0, limits.maxItems)
      .map((url) => truncateArtifactString(url, limits)),
    sourceArtifacts: processTrace.sourceArtifacts.slice(0, limits.maxItems).map((artifact) => ({
      ...artifact,
      url: truncateArtifactString(artifact.url, limits),
      label: artifact.label
        ? truncateArtifactString(artifact.label, limits)
        : artifact.label,
      error: artifact.error
        ? truncateArtifactString(artifact.error, limits)
        : artifact.error,
    })),
    notes: processTrace.notes
      .slice(0, limits.maxItems)
      .map((note) => truncateArtifactString(note, limits)),
    steps: processTrace.steps.slice(0, limits.maxItems).map((step) => ({
      ...step,
      label: truncateArtifactString(step.label, limits),
      input: truncateArtifactJson(step.input, limits),
      output: truncateArtifactJson(step.output, limits),
      error: step.error ? truncateArtifactString(step.error, limits) : step.error,
    })),
  };
}

function hasProcessTraceOverflow(
  processTrace: PopulateProcessTrace,
  limits: typeof PROCESS_TRACE_ARTIFACT_LIMITS[number]
): boolean {
  return (
    processTrace.searchQueries.length > limits.maxItems ||
    processTrace.fetchedUrls.length > limits.maxItems ||
    processTrace.sourceArtifacts.length > limits.maxItems ||
    processTrace.notes.length > limits.maxItems ||
    processTrace.steps.length > limits.maxItems ||
    processTrace.searchQueries.some((query) => query.length > limits.maxStringLength) ||
    processTrace.fetchedUrls.some((url) => url.length > limits.maxStringLength) ||
    processTrace.notes.some((note) => note.length > limits.maxStringLength) ||
    processTrace.sourceArtifacts.some((artifact) =>
      [
        artifact.url,
        artifact.label ?? "",
        artifact.error ?? "",
      ].some((value) => value.length > limits.maxStringLength)
    ) ||
    processTrace.steps.some((step) =>
      [
        step.label,
        step.error ?? "",
      ].some((value) => value.length > limits.maxStringLength)
    )
  );
}

function truncateArtifactJson(
  value: unknown,
  limits: typeof PROCESS_TRACE_ARTIFACT_LIMITS[number]
): unknown {
  if (typeof value === "string") {
    return truncateArtifactString(value, limits);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, limits.maxNestedItems)
      .map((nestedValue) => truncateArtifactJson(nestedValue, limits));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, limits.maxNestedItems)
        .map(([key, nestedValue]) => [
          key,
          truncateArtifactJson(nestedValue, limits),
        ])
    );
  }
  return value;
}

function truncateArtifactString(
  value: string,
  limits: typeof PROCESS_TRACE_ARTIFACT_LIMITS[number]
): string {
  return value.length > limits.maxStringLength
    ? `${value.slice(0, limits.maxStringLength)}\n[truncated]`
    : value;
}

export function emptyPopulateRuntimeResult(validationIssues: string[]): PopulateRuntimeResult {
  return {
    rows: [],
    validationIssues,
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
    debug: {
      capturedRows: [],
      capturedSources: [],
      selectedRowSource: "none",
      notes: [],
      processTrace: {
        runtime: "unknown",
        searchQueries: [],
        fetchedUrls: [],
        sourceArtifacts: [],
        selectedRowSource: "none",
        notes: [],
        steps: [],
      },
    },
  };
}

function isHealthyRun(runResult: PopulateRecipeRunResult): boolean {
  return runResult.runStatus === "succeeded" &&
    runResult.productionValidation.isValid;
}

function shouldPromoteCandidate(input: {
  activeRecipe: PopulateRecipe;
  activeRun: PopulateRecipeRunResult;
  candidateRun: PopulateRecipeRunResult;
}): boolean {
  const baselineScore =
    input.activeRecipe.lastValidationScore ??
    input.activeRun.productionValidation.score;
  return input.candidateRun.productionValidation.isValid &&
    input.candidateRun.productionValidation.score >=
      baselineScore;
}

function rejectionReasonsForCandidate(input: {
  activeRecipe: PopulateRecipe;
  activeRun: PopulateRecipeRunResult;
  candidateRun: PopulateRecipeRunResult;
}): string[] {
  const reasons = [...input.candidateRun.productionValidation.criticalIssues];
  const baselineScore =
    input.activeRecipe.lastValidationScore ??
    input.activeRun.productionValidation.score;
  if (
    input.candidateRun.productionValidation.score <
    baselineScore
  ) {
    reasons.push("Candidate validation score is below the active recipe baseline.");
  }
  return Array.from(new Set(reasons));
}

function successfulRecipe(
  recipe: PopulateRecipe,
  runResult: PopulateRecipeRunResult
): PopulateRecipe {
  return {
    ...recipe,
    status: "active",
    lastSuccessfulRunAt: runResult.completedAt,
    lastValidationScore: runResult.productionValidation.score,
  };
}

function runRecordFromRunResult(
  runResult: PopulateRecipeRunResult
): StoredPopulateRecipeRunRecord {
  return {
    recipeId: runResult.recipeId,
    recipeVersion: runResult.recipeVersion,
    runStatus: runResult.runStatus,
    completedAt: runResult.completedAt,
    productionValidation: runResult.productionValidation,
    artifacts: runResult.artifacts,
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
