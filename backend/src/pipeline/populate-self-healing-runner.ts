import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DatasetContext } from "./populate.js";
import {
  DefaultPopulateRecipeAuthor,
  FileSystemPopulateRecipeStore,
  MastraPopulateRecipeRuntime,
  SelfHealingPopulateRecipeService,
  safeRowsForPopulateCommit,
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

export interface PopulateDatasetRowCommitLimit {
  maxRowsPerWindow: number;
  windowMs: number;
  now?: () => Date;
  limiter?: PopulateDatasetRowCommitLimiter;
}

export interface PopulateDatasetRowCommitLimiter {
  committedRowCount(input: {
    datasetId: string;
    since: Date;
    now: Date;
  }): Promise<number>;
  reserveCommit(input: {
    datasetId: string;
    rowCount: number;
    since: Date;
    now: Date;
    maxRowsPerWindow: number;
  }): Promise<PopulateDatasetRowCommitReservation>;
}

export interface PopulateDatasetRowCommitReservation {
  decision: PopulateDatasetRowCommitLimitDecision;
  confirm(input: { rowCount: number }): Promise<void>;
  release(): Promise<void>;
}

interface PopulateDatasetRowCommitLimitCheck {
  datasetId: string;
  rowCount: number;
  now: Date;
  windowStartedAt: Date;
  maxRowsPerWindow: number;
  committedRowsInWindow: number;
}

interface FileSystemCommitLedgerEntry {
  datasetId: string;
  committedAt: string;
  rowCount: number;
  reservationId?: string;
  status?: "reserved" | "committed";
}

interface CommitLedgerReservationInput {
  entries: FileSystemCommitLedgerEntry[];
  reservationId: string;
  datasetId: string;
  rowCount: number;
  now: Date;
  since: Date;
  maxRowsPerWindow: number;
}

interface CommitLedgerReservationState {
  entries: FileSystemCommitLedgerEntry[];
  decision: PopulateDatasetRowCommitLimitDecision;
  reservation?: FileSystemCommitLedgerEntry;
}

interface CommitLedgerMutationInput {
  reservationId: string;
  datasetId: string;
  rowCount?: number;
}

interface CommitLedgerState {
  entries: FileSystemCommitLedgerEntry[];
}

interface CommitLedgerStore {
  mutateDatasetLedger<T>(
    datasetId: string,
    mutate: (state: CommitLedgerState) => Promise<T> | T
  ): Promise<T>;
}

interface CommitLedgerReservation {
  store: CommitLedgerStore;
  reservationId: string;
  datasetId: string;
  decision: PopulateDatasetRowCommitLimitDecision;
}

function commitLedgerReservation(
  input: CommitLedgerReservation
): PopulateDatasetRowCommitReservation {
  return {
    decision: input.decision,
    async confirm(confirmInput) {
      await input.store.mutateDatasetLedger(input.datasetId, (state) => {
        confirmReservation({
          entries: state.entries,
          reservationId: input.reservationId,
          datasetId: input.datasetId,
          rowCount: confirmInput.rowCount,
        });
      });
    },
    async release() {
      await input.store.mutateDatasetLedger(input.datasetId, (state) => {
        releaseReservation({
          entries: state.entries,
          reservationId: input.reservationId,
          datasetId: input.datasetId,
        });
      });
    },
  };
}

function deniedCommitReservation(
  decision: PopulateDatasetRowCommitLimitDecision
): PopulateDatasetRowCommitReservation {
  return {
    decision,
    async confirm() {
      return undefined;
    },
    async release() {
      return undefined;
    },
  };
}

function reserveInLedger(input: CommitLedgerReservationInput): CommitLedgerReservationState {
  const committedRowsInWindow = entriesInWindow(input.entries, {
    datasetId: input.datasetId,
    since: input.since,
    now: input.now,
  }).reduce((total, entry) => total + entry.rowCount, 0);
  const decision = commitLimitDecisionFromCheck({
    datasetId: input.datasetId,
    rowCount: input.rowCount,
    now: input.now,
    windowStartedAt: input.since,
    maxRowsPerWindow: input.maxRowsPerWindow,
    committedRowsInWindow,
  });

  if (!decision.isAllowed) {
    return { entries: input.entries, decision };
  }

  const reservation = {
    datasetId: input.datasetId,
    committedAt: input.now.toISOString(),
    rowCount: input.rowCount,
    reservationId: input.reservationId,
    status: "reserved" as const,
  };
  return {
    entries: [...input.entries, reservation],
    decision,
    reservation,
  };
}

function confirmReservation(input: CommitLedgerMutationInput & {
  entries: FileSystemCommitLedgerEntry[];
}): void {
  const entry = matchingReservation(input.entries, input);
  if (!entry) {
    return;
  }
  entry.status = "committed";
  if (input.rowCount !== undefined) {
    entry.rowCount = input.rowCount;
  }
}

function releaseReservation(input: CommitLedgerMutationInput & {
  entries: FileSystemCommitLedgerEntry[];
}): void {
  const index = input.entries.findIndex((entry) =>
    entry.datasetId === input.datasetId &&
    entry.reservationId === input.reservationId
  );
  if (index >= 0) {
    input.entries.splice(index, 1);
  }
}

function matchingReservation(
  entries: FileSystemCommitLedgerEntry[],
  input: CommitLedgerMutationInput
): FileSystemCommitLedgerEntry | undefined {
  return entries.find((entry) =>
    entry.datasetId === input.datasetId &&
    entry.reservationId === input.reservationId
  );
}

function commitLimitDecisionFromCheck(
  input: PopulateDatasetRowCommitLimitCheck
): PopulateDatasetRowCommitLimitDecision {
  const remainingRowsInWindow = Math.max(
    0,
    input.maxRowsPerWindow - input.committedRowsInWindow
  );
  const isAllowed = input.rowCount <= remainingRowsInWindow;

  return {
    isAllowed,
    datasetId: input.datasetId,
    requestedRowCount: input.rowCount,
    maxRowsPerWindow: input.maxRowsPerWindow,
    committedRowsInWindow: input.committedRowsInWindow,
    remainingRowsInWindow,
    windowStartedAt: input.windowStartedAt.toISOString(),
    windowEndsAt: input.now.toISOString(),
    reason: isAllowed
      ? undefined
      : `Commit row cap exceeded for ${input.datasetId}: requested ${input.rowCount}, remaining ${remainingRowsInWindow} of ${input.maxRowsPerWindow} rows in the current window.`,
  };
}

function reservationId(): string {
  return randomUUID();
}

export interface PopulateDatasetRowCommitLimitDecision {
  isAllowed: boolean;
  datasetId: string;
  requestedRowCount: number;
  maxRowsPerWindow: number;
  committedRowsInWindow: number;
  remainingRowsInWindow: number;
  windowStartedAt: string;
  windowEndsAt: string;
  reason?: string;
}

export type RunSelfHealingPopulateAction =
  | SelfHealingPopulateTickResult["action"]
  | "commit_rate_limited";

export interface RunSelfHealingPopulateInput {
  context: DatasetContext;
  store?: PopulateRecipeStore;
  runtime?: PopulateRecipeRuntime;
  author?: PopulateRecipeAuthor;
  rowWriter?: PopulateDatasetRowWriter;
  shouldCommitRows?: boolean;
  recipeStoreDirectory?: string;
  commitRowLimit?: PopulateDatasetRowCommitLimit;
}

export interface RunSelfHealingPopulateResult {
  success: boolean;
  action: RunSelfHealingPopulateAction;
  datasetId: string;
  selectedRun?: PopulateRecipeRunResult;
  diagnosticRun?: PopulateRecipeRunResult;
  committedRows?: PopulateDatasetWriteResult;
  commitLimit?: PopulateDatasetRowCommitLimitDecision;
  validationState?: PopulateRecipeRunResult["productionValidation"]["state"];
  rejectionReasons: string[];
  validationIssues: string[];
  tick?: SelfHealingPopulateTickResult;
}

export async function runSelfHealingPopulate(
  input: RunSelfHealingPopulateInput
): Promise<RunSelfHealingPopulateResult> {
  if (input.shouldCommitRows && !input.rowWriter) {
    throw new Error("rowWriter is required when shouldCommitRows is true.");
  }
  const rowWriter = input.rowWriter;
  const commitLimiter = commitLimiterForInput(input);

  if (input.shouldCommitRows && commitLimiter) {
    const preflightDecision = await commitLimitDecision({
      context: input.context,
      rowCount: 1,
      commitRowLimit: input.commitRowLimit!,
      limiter: commitLimiter,
    });
    if (!preflightDecision.isAllowed && preflightDecision.remainingRowsInWindow <= 0) {
      return commitRateLimitedResult({
        datasetId: input.context.datasetId,
        decision: preflightDecision,
      });
    }
  }

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
  const selectedRun = committableRunForTick(tick);
  const diagnosticRun = diagnosticRunForTick(tick);
  const rowsToCommit = selectedRun
    ? safeRowsForPopulateCommit({ context: input.context, run: selectedRun })
    : [];
  let committedRows: PopulateDatasetWriteResult | undefined;
  let commitLimit: PopulateDatasetRowCommitLimitDecision | undefined;

  if (input.shouldCommitRows && selectedRun && rowWriter) {
    let reservation: PopulateDatasetRowCommitReservation | undefined;
    if (commitLimiter) {
      reservation = await reserveCommitRows({
        context: input.context,
        rowCount: rowsToCommit.length,
        commitRowLimit: input.commitRowLimit!,
        limiter: commitLimiter,
      });
      commitLimit = reservation.decision;
      if (!commitLimit.isAllowed) {
        return commitRateLimitedResult({
          datasetId: input.context.datasetId,
          decision: commitLimit,
          selectedRun,
          diagnosticRun,
          tick,
        });
      }
    }
    try {
      committedRows = await rowWriter.replaceRows({
        datasetId: input.context.datasetId,
        rows: rowsToCommit,
      });
    } catch (error) {
      await reservation?.release();
      throw error;
    }
    await reservation?.confirm({ rowCount: committedRows.insertedRowCount });
  }

  return {
    success: Boolean(selectedRun),
    action: tick.action,
    datasetId: input.context.datasetId,
    selectedRun,
    diagnosticRun,
    committedRows,
    commitLimit,
    validationState: selectedRun?.productionValidation.state ??
      diagnosticRun?.productionValidation.state,
    rejectionReasons: tick.rejectionReasons,
    validationIssues: validationIssuesForSelfHealingTick(tick),
    tick,
  };
}

function committableRunForTick(
  tick: SelfHealingPopulateTickResult
): PopulateRecipeRunResult | undefined {
  return successfulRunForTick(tick) ?? acceptedPartialRunForTick(tick);
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

function acceptedPartialRunForTick(
  tick: SelfHealingPopulateTickResult
): PopulateRecipeRunResult | undefined {
  return [tick.candidateRun, tick.activeRun].find((run) =>
    run?.productionValidation.state === "accepted_partial" &&
    run.productionValidation.safeRowCount > 0
  );
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

function commitLimiterForInput(
  input: RunSelfHealingPopulateInput
): PopulateDatasetRowCommitLimiter | undefined {
  if (!input.shouldCommitRows || !input.commitRowLimit) {
    return undefined;
  }
  return input.commitRowLimit.limiter ?? new FileSystemPopulateDatasetRowCommitLimiter(
    join(
      input.recipeStoreDirectory ?? defaultPopulateRecipeStoreDirectory(),
      "commit-ledger"
    )
  );
}

async function commitLimitDecision(input: {
  context: DatasetContext;
  rowCount: number;
  commitRowLimit: PopulateDatasetRowCommitLimit;
  limiter: PopulateDatasetRowCommitLimiter;
}): Promise<PopulateDatasetRowCommitLimitDecision> {
  const now = input.commitRowLimit.now?.() ?? new Date();
  const windowStartedAt = new Date(now.getTime() - input.commitRowLimit.windowMs);
  const committedRowsInWindow = await input.limiter.committedRowCount({
    datasetId: input.context.datasetId,
    since: windowStartedAt,
    now,
  });
  return commitLimitDecisionFromCheck({
    datasetId: input.context.datasetId,
    rowCount: input.rowCount,
    now,
    windowStartedAt,
    maxRowsPerWindow: input.commitRowLimit.maxRowsPerWindow,
    committedRowsInWindow,
  });
}

async function reserveCommitRows(input: {
  context: DatasetContext;
  rowCount: number;
  commitRowLimit: PopulateDatasetRowCommitLimit;
  limiter: PopulateDatasetRowCommitLimiter;
}): Promise<PopulateDatasetRowCommitReservation> {
  const now = input.commitRowLimit.now?.() ?? new Date();
  const windowStartedAt = new Date(now.getTime() - input.commitRowLimit.windowMs);
  return input.limiter.reserveCommit({
    datasetId: input.context.datasetId,
    rowCount: input.rowCount,
    since: windowStartedAt,
    now,
    maxRowsPerWindow: input.commitRowLimit.maxRowsPerWindow,
  });
}

function commitRateLimitedResult(input: {
  datasetId: string;
  decision: PopulateDatasetRowCommitLimitDecision;
  selectedRun?: PopulateRecipeRunResult;
  diagnosticRun?: PopulateRecipeRunResult;
  tick?: SelfHealingPopulateTickResult;
}): RunSelfHealingPopulateResult {
  const reason = input.decision.reason ??
    `Commit row cap exceeded for ${input.datasetId}.`;
  return {
    success: false,
    action: "commit_rate_limited",
    datasetId: input.datasetId,
    selectedRun: input.selectedRun,
    diagnosticRun: input.diagnosticRun ?? input.selectedRun,
    commitLimit: input.decision,
    validationState: input.selectedRun?.productionValidation.state ??
      input.diagnosticRun?.productionValidation.state,
    rejectionReasons: [reason],
    validationIssues: [reason],
    tick: input.tick,
  };
}

export class InMemoryPopulateDatasetRowCommitLimiter
implements PopulateDatasetRowCommitLimiter, CommitLedgerStore {
  private readonly entries: FileSystemCommitLedgerEntry[] = [];

  async committedRowCount(input: {
    datasetId: string;
    since: Date;
    now: Date;
  }): Promise<number> {
    return entriesInWindow(this.entries, input)
      .reduce((total, entry) => total + entry.rowCount, 0);
  }

  async reserveCommit(input: {
    datasetId: string;
    rowCount: number;
    since: Date;
    now: Date;
    maxRowsPerWindow: number;
  }): Promise<PopulateDatasetRowCommitReservation> {
    const id = reservationId();
    const state = reserveInLedger({
      entries: this.entries,
      reservationId: id,
      datasetId: input.datasetId,
      rowCount: input.rowCount,
      since: input.since,
      now: input.now,
      maxRowsPerWindow: input.maxRowsPerWindow,
    });
    this.entries.splice(0, this.entries.length, ...state.entries);
    return state.reservation
      ? commitLedgerReservation({
        store: this,
        reservationId: id,
        datasetId: input.datasetId,
        decision: state.decision,
      })
      : deniedCommitReservation(state.decision);
  }

  async mutateDatasetLedger<T>(
    _datasetId: string,
    mutate: (state: CommitLedgerState) => Promise<T> | T
  ): Promise<T> {
    return mutate({ entries: this.entries });
  }
}

export class FileSystemPopulateDatasetRowCommitLimiter
implements PopulateDatasetRowCommitLimiter, CommitLedgerStore {
  constructor(private readonly rootDirectory: string) {}

  async committedRowCount(input: {
    datasetId: string;
    since: Date;
    now: Date;
  }): Promise<number> {
    return entriesInWindow(await this.readEntries(input.datasetId), input)
      .reduce((total, entry) => total + entry.rowCount, 0);
  }

  async reserveCommit(input: {
    datasetId: string;
    rowCount: number;
    since: Date;
    now: Date;
    maxRowsPerWindow: number;
  }): Promise<PopulateDatasetRowCommitReservation> {
    const id = reservationId();
    const state = await this.mutateDatasetLedger(input.datasetId, (ledger) => {
      const reservationState = reserveInLedger({
        entries: ledger.entries,
        reservationId: id,
        datasetId: input.datasetId,
        rowCount: input.rowCount,
        since: input.since,
        now: input.now,
        maxRowsPerWindow: input.maxRowsPerWindow,
      });
      ledger.entries.splice(0, ledger.entries.length, ...reservationState.entries);
      return reservationState;
    });
    return state.reservation
      ? commitLedgerReservation({
        store: this,
        reservationId: id,
        datasetId: input.datasetId,
        decision: state.decision,
      })
      : deniedCommitReservation(state.decision);
  }

  async mutateDatasetLedger<T>(
    datasetId: string,
    mutate: (state: CommitLedgerState) => Promise<T> | T
  ): Promise<T> {
    const lockPath = await this.acquireLock(datasetId);
    try {
      const entries = await this.readEntries(datasetId);
      const state = { entries };
      const result = await mutate(state);
      await this.writeEntries(datasetId, state.entries);
      return result;
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async acquireLock(datasetId: string): Promise<string> {
    await mkdir(this.rootDirectory, { recursive: true });
    const lockPath = this.lockPath(datasetId);
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(lockPath);
        return lockPath;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        if (Date.now() - startedAt > 5_000) {
          throw new Error(`Timed out waiting for commit ledger lock for ${datasetId}.`);
        }
        await sleep(25);
      }
    }
  }

  private lockPath(datasetId: string): string {
    return join(this.rootDirectory, `${safePathSegment(datasetId)}.lock`);
  }

  private async readEntries(datasetId: string): Promise<FileSystemCommitLedgerEntry[]> {
    try {
      const text = await readFile(this.ledgerPath(datasetId), "utf8");
      const parsed = JSON.parse(text) as { entries?: FileSystemCommitLedgerEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeEntries(
    datasetId: string,
    entries: FileSystemCommitLedgerEntry[]
  ): Promise<void> {
    const path = this.ledgerPath(datasetId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  }

  private ledgerPath(datasetId: string): string {
    return join(this.rootDirectory, `${safePathSegment(datasetId)}.json`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entriesInWindow(
  entries: FileSystemCommitLedgerEntry[],
  input: {
    datasetId: string;
    since: Date;
    now: Date;
  }
): FileSystemCommitLedgerEntry[] {
  return entries.filter((entry) => {
    if (entry.datasetId !== input.datasetId) {
      return false;
    }
    const committedAtMs = Date.parse(entry.committedAt);
    return Number.isFinite(committedAtMs) &&
      committedAtMs >= input.since.getTime() &&
      committedAtMs <= input.now.getTime();
  });
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
