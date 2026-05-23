import { join } from "node:path";

import type { DatasetContext } from "./populate.js";
import {
  DefaultPopulateRecipeAuthor,
  FileSystemPopulateRecipeStore,
  MastraPopulateRecipeRuntime,
  SelfHealingPopulateRecipeService,
  type PopulateRecipeAuthor,
  type PopulateRecipeRunResult,
  type PopulateRecipeRuntime,
  type PopulateRecipeStore,
  type SelfHealingPopulateTickResult,
} from "./populate-self-healing.js";

export interface PopulateDatasetRowWriter {
  replaceRows(input: {
    datasetId: string;
    rows: PopulateRecipeRunResult["rows"];
  }): Promise<PopulateDatasetWriteResult>;
}

export interface PopulateDatasetWriteResult {
  clearedRowCount?: number;
  insertedRowCount: number;
}

export interface RunSelfHealingPopulateInput {
  context: DatasetContext;
  store?: PopulateRecipeStore;
  runtime?: PopulateRecipeRuntime;
  author?: PopulateRecipeAuthor;
  rowWriter?: PopulateDatasetRowWriter;
  shouldCommitRows?: boolean;
  recipeStoreDirectory?: string;
}

export interface RunSelfHealingPopulateResult {
  success: boolean;
  action: SelfHealingPopulateTickResult["action"];
  datasetId: string;
  selectedRun?: PopulateRecipeRunResult;
  diagnosticRun?: PopulateRecipeRunResult;
  committedRows?: PopulateDatasetWriteResult;
  rejectionReasons: string[];
  validationIssues: string[];
  tick: SelfHealingPopulateTickResult;
}

export async function runSelfHealingPopulate(
  input: RunSelfHealingPopulateInput
): Promise<RunSelfHealingPopulateResult> {
  if (input.shouldCommitRows && !input.rowWriter) {
    throw new Error("rowWriter is required when shouldCommitRows is true.");
  }
  const rowWriter = input.rowWriter;

  const store = input.store ?? new FileSystemPopulateRecipeStore(
    input.recipeStoreDirectory ?? defaultPopulateRecipeStoreDirectory()
  );
  const service = new SelfHealingPopulateRecipeService({
    store,
    runtime: input.runtime ?? new MastraPopulateRecipeRuntime(),
    author: input.author ?? new DefaultPopulateRecipeAuthor(),
  });
  const tick = await service.tick({
    datasetId: input.context.datasetId,
    context: input.context,
  });
  const selectedRun = successfulRunForTick(tick);
  const diagnosticRun = diagnosticRunForTick(tick);
  let committedRows: PopulateDatasetWriteResult | undefined;

  if (input.shouldCommitRows && selectedRun && rowWriter) {
    committedRows = await rowWriter.replaceRows({
      datasetId: input.context.datasetId,
      rows: selectedRun.rows,
    });
  }

  return {
    success: Boolean(selectedRun),
    action: tick.action,
    datasetId: input.context.datasetId,
    selectedRun,
    diagnosticRun,
    committedRows,
    rejectionReasons: tick.rejectionReasons,
    validationIssues: validationIssuesForSelfHealingTick(tick),
    tick,
  };
}

export function successfulRunForTick(
  tick: SelfHealingPopulateTickResult
): PopulateRecipeRunResult | undefined {
  if (tick.action === "active_rerun_succeeded") {
    return tick.activeRun;
  }
  if (
    tick.action === "generated_initial_recipe" ||
    tick.action === "repaired_active_recipe"
  ) {
    return tick.candidateRun;
  }
  return undefined;
}

export function diagnosticRunForTick(
  tick: SelfHealingPopulateTickResult
): PopulateRecipeRunResult | undefined {
  return successfulRunForTick(tick) ?? tick.candidateRun ?? tick.activeRun;
}

export function validationIssuesForSelfHealingTick(
  tick: SelfHealingPopulateTickResult
): string[] {
  const run = diagnosticRunForTick(tick);
  return Array.from(new Set([
    ...(run?.validationIssues ?? []),
    ...(run?.productionValidation.criticalIssues ?? []),
    ...tick.rejectionReasons,
  ]));
}

function defaultPopulateRecipeStoreDirectory(): string {
  return join(process.cwd(), ".bigset", "populate-recipes");
}
