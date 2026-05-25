import { createHash, randomUUID } from "node:crypto";

import {
  populateProcessTraceFromSteps,
  type PopulateCellValue,
  type PopulateRuntimeDebug,
  type PopulateRuntimeResult,
  type PopulateRuntimeRow,
  type PopulateRuntimeTraceStep,
} from "./populate-runtime.js";
import {
  playwrightCandidateReadinessForRun,
  type PopulatePlaywrightCandidateReadiness,
} from "./populate-playwright-readiness.js";
import { playwrightCandidateScriptForRun } from "./populate-playwright-candidate-script.js";
import {
  recordTinyFishTrace,
  createTinyFishTraceRecorderClient,
  tinyFishTraceProcessSteps,
  type TinyFishRecordedTrace,
  type TinyFishTraceRecorderClient,
} from "./populate-tinyfish-trace-recorder.js";

export interface BrowserActionBoxDatasetSchema {
  columns: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  dedupeKey?: string;
}

export interface BrowserActionBoxRunCaps {
  maxAgentSteps: number;
  maxDurationSeconds: number;
  captureHtml: boolean;
  captureScreenshots: boolean;
}

export interface PlaywrightScriptRegistryKey {
  sourceUrlCanonical: string;
  datasetGoalFingerprint: string;
  datasetSchemaFingerprint: string;
  promptPolicyVersion: string;
  scriptGeneratorVersion: string;
}

export interface PlaywrightScriptArtifact {
  scriptId: string;
  sourceUrl: string;
  createdAt: string;
  status: "draft" | "promoted" | "rejected";
  generatorVersion: string;
  registryKey: PlaywrightScriptRegistryKey;
  code: string;
  diagnostics: string[];
}

export interface BrowserActionBoxFirstRunInput {
  sourceUrl: string;
  datasetGoalPrompt: string;
  datasetSchema: BrowserActionBoxDatasetSchema;
  runCaps: BrowserActionBoxRunCaps;
}

export interface BrowserActionBoxFirstRunOutput {
  agentCompatibleResult: Record<string, unknown>;
  runtimeResult: PopulateRuntimeResult;
  trace: TinyFishRecordedTrace;
  playwrightScript: PlaywrightScriptArtifact | null;
  replayReadiness: PopulatePlaywrightCandidateReadiness;
  diagnostics: string[];
}

export interface BrowserActionBoxReplayInput {
  sourceUrl: string;
  datasetGoalPrompt: string;
  datasetSchema: BrowserActionBoxDatasetSchema;
  currentPlaywrightScript: PlaywrightScriptArtifact;
  previousSuccessfulOutputProfile: {
    fieldsPreviouslyRetrieved: string[];
    rowCountRange?: { min: number; max?: number };
    sourceUrls: string[];
    evidenceRequired: boolean;
  };
  runCaps: {
    maxReplayAttempts: 1;
    maxRepairAttempts: 1;
    timeoutMs: number;
  };
}

export interface PlaywrightReplayTrace {
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  scriptId: string;
  sourceUrl: string;
  failedStepIndex?: number;
  failedAction?: string;
  currentUrl?: string;
  error?: string;
  screenshotRef?: string;
  htmlRef?: string;
  diagnostics: string[];
  steps: PopulateRuntimeTraceStep[];
}

export interface BrowserActionBoxReplayOutput {
  agentCompatibleResult: Record<string, unknown> | null;
  runtimeResult: PopulateRuntimeResult | null;
  trace: PlaywrightReplayTrace;
  replayStatus:
    | "replay_succeeded"
    | "replay_failed"
    | "repair_promoted"
    | "repair_rejected";
  repairedPlaywrightScript?: PlaywrightScriptArtifact;
  diagnostics: string[];
}

export interface PlaywrightReplayRunnerResult {
  agentCompatibleResult: Record<string, unknown> | null;
  trace?: Partial<PlaywrightReplayTrace>;
  error?: string;
}

export interface BrowserActionBoxHooks {
  tinyFishClient: TinyFishTraceRecorderClient;
  runPlaywrightScript?: (
    input: BrowserActionBoxReplayInput & {
      script: PlaywrightScriptArtifact;
    }
  ) => Promise<PlaywrightReplayRunnerResult>;
  repairPlaywrightScript?: (
    input: BrowserActionBoxReplayInput & {
      failedReplay: PlaywrightReplayTrace;
      diagnostics: string[];
    }
  ) => Promise<PlaywrightScriptArtifact | null>;
  now?: () => Date;
}

export class BrowserActionBox {
  constructor(private readonly hooks: BrowserActionBoxHooks) {}

  async firstRun(
    input: BrowserActionBoxFirstRunInput
  ): Promise<BrowserActionBoxFirstRunOutput> {
    const trace = await recordTinyFishTrace({
      sourceUrl: input.sourceUrl,
      goal: browserActionBoxGoal(input),
      captureHtml: input.runCaps.captureHtml,
      captureScreenshots: input.runCaps.captureScreenshots,
      maxDurationSeconds: input.runCaps.maxDurationSeconds,
      maxAgentSteps: input.runCaps.maxAgentSteps,
      client: this.hooks.tinyFishClient,
    });
    const agentCompatibleResult = trace.finalResult ?? { rows: [] };
    const runtimeResult = populateRuntimeResultFromAgentCompatibleResult({
      agentCompatibleResult,
      datasetSchema: input.datasetSchema,
      sourceUrl: input.sourceUrl,
      trace,
      diagnosticArtifacts: [{
        kind: "tinyfish-trace",
        label: "populate-tinyfish-trace",
        content: safeJsonStringify(trace),
      }],
    });
    const replayReadiness = playwrightCandidateReadinessForRun({
      result: runtimeResult,
    });
    const code = playwrightCandidateScriptForRun({ result: runtimeResult });
    const playwrightScript = code
      ? createPlaywrightScriptArtifact({
        sourceUrl: input.sourceUrl,
        datasetGoalPrompt: input.datasetGoalPrompt,
        datasetSchema: input.datasetSchema,
        code,
        status: "draft",
        createdAt: this.now().toISOString(),
        diagnostics: replayReadiness.reasons,
      })
      : null;

    return {
      agentCompatibleResult,
      runtimeResult,
      trace,
      playwrightScript,
      replayReadiness,
      diagnostics: trace.diagnostics,
    };
  }

  async replay(
    input: BrowserActionBoxReplayInput
  ): Promise<BrowserActionBoxReplayOutput> {
    const replay = await this.runPlaywrightScript({
      ...input,
      script: input.currentPlaywrightScript,
    });
    const replayTrace = this.replayTraceFromRunner({
      input,
      result: replay,
      script: input.currentPlaywrightScript,
    });
    const replayValidation = validateReplayAgentCompatibleResult({
      agentCompatibleResult: replay.agentCompatibleResult,
      profile: input.previousSuccessfulOutputProfile,
    });

    if (replayTrace.status === "succeeded" && replayValidation.isValid) {
      const runtimeResult = populateRuntimeResultFromReplay({
        input,
        agentCompatibleResult: replay.agentCompatibleResult!,
        trace: replayTrace,
        status: "replay_succeeded",
      });
      return {
        agentCompatibleResult: replay.agentCompatibleResult,
        runtimeResult,
        trace: replayTrace,
        replayStatus: "replay_succeeded",
        diagnostics: replayValidation.issues,
      };
    }

    const failureDiagnostics = [
      ...replayTrace.diagnostics,
      ...replayValidation.issues,
      classifyReplayFailure({
        replayTrace,
        validationIssues: replayValidation.issues,
      }),
    ];
    if (!this.hooks.repairPlaywrightScript || input.runCaps.maxRepairAttempts < 1) {
      return {
        agentCompatibleResult: null,
        runtimeResult: null,
        trace: replayTrace,
        replayStatus: "replay_failed",
        diagnostics: failureDiagnostics,
      };
    }

    const repairedScript = await this.hooks.repairPlaywrightScript({
      ...input,
      failedReplay: replayTrace,
      diagnostics: failureDiagnostics,
    });
    if (!repairedScript) {
      return {
        agentCompatibleResult: null,
        runtimeResult: null,
        trace: replayTrace,
        replayStatus: "repair_rejected",
        diagnostics: [...failureDiagnostics, "Repair did not produce a script candidate."],
      };
    }

    const repairedReplay = await this.runPlaywrightScript({
      ...input,
      currentPlaywrightScript: repairedScript,
      script: repairedScript,
    });
    const repairedTrace = this.replayTraceFromRunner({
      input,
      result: repairedReplay,
      script: repairedScript,
    });
    const repairedValidation = validateReplayAgentCompatibleResult({
      agentCompatibleResult: repairedReplay.agentCompatibleResult,
      profile: input.previousSuccessfulOutputProfile,
    });
    if (repairedTrace.status === "succeeded" && repairedValidation.isValid) {
      const promotedScript = {
        ...repairedScript,
        status: "promoted" as const,
        diagnostics: repairedValidation.issues,
      };
      const runtimeResult = populateRuntimeResultFromReplay({
        input,
        agentCompatibleResult: repairedReplay.agentCompatibleResult!,
        trace: repairedTrace,
        status: "repair_promoted",
        repairedScript: promotedScript,
      });
      return {
        agentCompatibleResult: repairedReplay.agentCompatibleResult,
        runtimeResult,
        trace: repairedTrace,
        replayStatus: "repair_promoted",
        repairedPlaywrightScript: promotedScript,
        diagnostics: repairedValidation.issues,
      };
    }

    return {
      agentCompatibleResult: null,
      runtimeResult: null,
      trace: repairedTrace,
      replayStatus: "repair_rejected",
      diagnostics: [
        ...failureDiagnostics,
        ...repairedTrace.diagnostics,
        ...repairedValidation.issues,
      ],
    };
  }

  private async runPlaywrightScript(
    input: BrowserActionBoxReplayInput & { script: PlaywrightScriptArtifact }
  ): Promise<PlaywrightReplayRunnerResult> {
    if (!this.hooks.runPlaywrightScript) {
      return {
        agentCompatibleResult: null,
        error: "No Playwright replay runner is configured.",
      };
    }
    return this.hooks.runPlaywrightScript(input);
  }

  private replayTraceFromRunner(input: {
    input: BrowserActionBoxReplayInput;
    script: PlaywrightScriptArtifact;
    result: PlaywrightReplayRunnerResult;
  }): PlaywrightReplayTrace {
    const now = this.now();
    const startedAt =
      input.result.trace?.startedAt ??
      new Date(now.getTime() - 1).toISOString();
    const completedAt = input.result.trace?.completedAt ?? now.toISOString();
    const status = input.result.error || !input.result.agentCompatibleResult
      ? "failed"
      : input.result.trace?.status ?? "succeeded";
    return {
      status,
      startedAt,
      completedAt,
      scriptId: input.script.scriptId,
      sourceUrl: input.input.sourceUrl,
      failedStepIndex: input.result.trace?.failedStepIndex,
      failedAction: input.result.trace?.failedAction,
      currentUrl: input.result.trace?.currentUrl,
      error: input.result.error ?? input.result.trace?.error,
      screenshotRef: input.result.trace?.screenshotRef,
      htmlRef: input.result.trace?.htmlRef,
      diagnostics: [
        ...(input.result.trace?.diagnostics ?? []),
        ...(input.result.error ? [input.result.error] : []),
      ],
      steps: input.result.trace?.steps ?? [{
        kind: "browser",
        label: "playwright-replay",
        status: status === "succeeded" ? "succeeded" : "failed",
        input: {
          sourceUrl: input.input.sourceUrl,
          scriptId: input.script.scriptId,
        },
        error: input.result.error,
      }],
    };
  }

  private now(): Date {
    return this.hooks.now?.() ?? new Date();
  }
}

export function createTinyFishBrowserActionBox(input: {
  apiKey: string;
  pollIntervalMs?: number;
  runPlaywrightScript?: BrowserActionBoxHooks["runPlaywrightScript"];
  repairPlaywrightScript?: BrowserActionBoxHooks["repairPlaywrightScript"];
}): BrowserActionBox {
  return new BrowserActionBox({
    tinyFishClient: createTinyFishTraceRecorderClient(input),
    runPlaywrightScript: input.runPlaywrightScript,
    repairPlaywrightScript: input.repairPlaywrightScript,
  });
}

export function createPlaywrightScriptArtifact(input: {
  sourceUrl: string;
  datasetGoalPrompt: string;
  datasetSchema: BrowserActionBoxDatasetSchema;
  code: string;
  status: PlaywrightScriptArtifact["status"];
  createdAt: string;
  diagnostics?: string[];
}): PlaywrightScriptArtifact {
  const registryKey = playwrightScriptRegistryKey(input);
  return {
    scriptId: `pw-${shortHash(JSON.stringify(registryKey))}`,
    sourceUrl: input.sourceUrl,
    createdAt: input.createdAt,
    status: input.status,
    generatorVersion: registryKey.scriptGeneratorVersion,
    registryKey,
    code: input.code,
    diagnostics: input.diagnostics ?? [],
  };
}

export function playwrightScriptRegistryKey(input: {
  sourceUrl: string;
  datasetGoalPrompt: string;
  datasetSchema: BrowserActionBoxDatasetSchema;
}): PlaywrightScriptRegistryKey {
  return {
    sourceUrlCanonical: canonicalSourceUrl(input.sourceUrl),
    datasetGoalFingerprint: shortHash(input.datasetGoalPrompt),
    datasetSchemaFingerprint: shortHash(JSON.stringify(input.datasetSchema)),
    promptPolicyVersion: "bigset-populate-v1",
    scriptGeneratorVersion: "browser-action-box-v1",
  };
}

export function populateRuntimeResultFromAgentCompatibleResult(input: {
  agentCompatibleResult: Record<string, unknown>;
  datasetSchema: BrowserActionBoxDatasetSchema;
  sourceUrl: string;
  trace?: TinyFishRecordedTrace;
  replayTrace?: PlaywrightReplayTrace;
  diagnosticArtifacts?: NonNullable<PopulateRuntimeDebug["diagnosticArtifacts"]>;
}): PopulateRuntimeResult {
  const rows = rowsFromAgentCompatibleResult({
    agentCompatibleResult: input.agentCompatibleResult,
    datasetSchema: input.datasetSchema,
    fallbackSourceUrl: input.sourceUrl,
  });
  const traceSteps = input.trace
    ? tinyFishTraceProcessSteps(input.trace)
    : input.replayTrace?.steps ?? [];
  const processTrace = populateProcessTraceFromSteps({
    runtime: input.trace ? "collection" : "unknown",
    steps: traceSteps,
    capturedSources: [{
      url: input.sourceUrl,
      text: safeJsonStringify(input.agentCompatibleResult).slice(0, 12_000),
      source: "synthetic",
    }],
    selectedRowSource: rows.length > 0 ? "collection_pipeline" : "none",
    notes: [
      ...(input.trace?.diagnostics ?? []),
      ...(input.replayTrace?.diagnostics ?? []),
    ],
  });
  return {
    rows,
    validationIssues: rows.length > 0 ? [] : ["BrowserActionBox returned no rows."],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metrics: {
      searchCalls: 0,
      fetchCalls: 0,
      browserCalls: input.trace || input.replayTrace ? 1 : 0,
      agentRuns: input.trace ? 1 : 0,
      agentSteps: input.trace?.runSteps.length ?? input.replayTrace?.steps.length ?? 0,
    },
    debug: {
      capturedRows: [],
      capturedSources: [{
        url: input.sourceUrl,
        text: safeJsonStringify(input.agentCompatibleResult).slice(0, 12_000),
        source: "synthetic",
      }],
      selectedRowSource: rows.length > 0 ? "collection_pipeline" : "none",
      notes: [
        ...(input.trace?.diagnostics ?? []),
        ...(input.replayTrace?.diagnostics ?? []),
      ],
      processTrace,
      diagnosticArtifacts: input.diagnosticArtifacts ?? [],
    },
  };
}

export function validateReplayAgentCompatibleResult(input: {
  agentCompatibleResult: Record<string, unknown> | null;
  profile: BrowserActionBoxReplayInput["previousSuccessfulOutputProfile"];
}): { isValid: boolean; issues: string[] } {
  if (!input.agentCompatibleResult) {
    return { isValid: false, issues: ["Replay returned no Agent-compatible result."] };
  }
  const rows = agentCompatibleRows(input.agentCompatibleResult);
  const issues: string[] = [];
  const minRows = input.profile.rowCountRange?.min ?? 1;
  if (rows.length < minRows) {
    issues.push(`Replay returned ${rows.length} row(s), below previous minimum ${minRows}.`);
  }
  if (
    input.profile.rowCountRange?.max !== undefined &&
    rows.length > input.profile.rowCountRange.max
  ) {
    issues.push(
      `Replay returned ${rows.length} row(s), above previous maximum ${input.profile.rowCountRange.max}.`
    );
  }
  const missingFields = input.profile.fieldsPreviouslyRetrieved.filter(
    (field) => !rows.some((row) => rowHasField(row, field))
  );
  if (missingFields.length > 0) {
    issues.push(`Replay missed previously retrieved field(s): ${missingFields.join(", ")}.`);
  }
  if (
    input.profile.evidenceRequired &&
    !rows.some((row) => rowHasEvidence(row))
  ) {
    issues.push("Replay returned no evidence-backed rows.");
  }
  return { isValid: issues.length === 0, issues };
}

export function classifyReplayFailure(input: {
  replayTrace: PlaywrightReplayTrace;
  validationIssues: string[];
}): string {
  const text = [
    input.replayTrace.error,
    input.replayTrace.currentUrl,
    input.replayTrace.diagnostics.join("\n"),
    input.validationIssues.join("\n"),
  ].filter(Boolean).join("\n");
  if (/captcha|verify you are human|bot|blocked/i.test(text)) {
    return "blocked/captcha/auth wall";
  }
  if (/404|not found|gone|no longer|unavailable/i.test(text)) {
    return "source unavailable";
  }
  if (input.validationIssues.length > 0) {
    return "validation failure";
  }
  if (/timeout|selector|locator|click|navigation/i.test(text)) {
    return "script failure";
  }
  return "script failure";
}

function populateRuntimeResultFromReplay(input: {
  input: BrowserActionBoxReplayInput;
  agentCompatibleResult: Record<string, unknown>;
  trace: PlaywrightReplayTrace;
  status: BrowserActionBoxReplayOutput["replayStatus"];
  repairedScript?: PlaywrightScriptArtifact;
}): PopulateRuntimeResult {
  const diagnosticArtifacts: NonNullable<PopulateRuntimeDebug["diagnosticArtifacts"]> = [{
    kind: "playwright-replay-result",
    label: "populate-playwright-replay-result",
    content: safeJsonStringify({
      replayStatus: input.status,
      trace: input.trace,
    }),
  }];
  if (input.status === "repair_promoted" && input.repairedScript) {
    diagnosticArtifacts.push({
      kind: "playwright-repaired-script",
      label: "populate-playwright-repaired-script",
      content: input.repairedScript.code,
    });
  }
  return populateRuntimeResultFromAgentCompatibleResult({
    agentCompatibleResult: input.agentCompatibleResult,
    datasetSchema: input.input.datasetSchema,
    sourceUrl: input.input.sourceUrl,
    replayTrace: input.trace,
    diagnosticArtifacts,
  });
}

function rowsFromAgentCompatibleResult(input: {
  agentCompatibleResult: Record<string, unknown>;
  datasetSchema: BrowserActionBoxDatasetSchema;
  fallbackSourceUrl: string;
}): PopulateRuntimeRow[] {
  const rawRows = agentCompatibleRows(input.agentCompatibleResult);
  return rawRows
    .map((row) => runtimeRowFromUnknown({
      row,
      datasetSchema: input.datasetSchema,
      fallbackSourceUrl: input.fallbackSourceUrl,
    }))
    .filter((row): row is PopulateRuntimeRow => Boolean(row));
}

function runtimeRowFromUnknown(input: {
  row: unknown;
  datasetSchema: BrowserActionBoxDatasetSchema;
  fallbackSourceUrl: string;
}): PopulateRuntimeRow | undefined {
  if (!isRecord(input.row)) {
    return undefined;
  }
  const cells = isRecord(input.row.cells)
    ? input.row.cells
    : isRecord(input.row.row)
      ? input.row.row
      : input.row;
  const sourceUrls = uniqueHttpUrls([
    ...arrayValue(input.row.sourceUrls).filter(isString),
    ...arrayValue(input.row.source_urls).filter(isString),
    ...sourceUrlsFromCells(cells),
    input.fallbackSourceUrl,
  ]);
  const evidence = evidenceFromRow({
    row: input.row,
    cells,
    fallbackSourceUrl: sourceUrls[0] ?? input.fallbackSourceUrl,
  });
  const normalizedCells: Record<string, PopulateCellValue> = Object.fromEntries(
    input.datasetSchema.columns.map((column) => [
      column.name,
      normalizeCellValue(cells[column.name]),
    ])
  );
  return {
    cells: normalizedCells,
    sourceUrls,
    evidence,
    needsReview: true,
  };
}

function evidenceFromUnknown(
  value: unknown,
  fallbackSourceUrl: string
): PopulateRuntimeRow["evidence"] {
  return arrayValue(value)
    .map((item) => {
      if (!isRecord(item)) {
        return undefined;
      }
      const quote = stringValue(item.quote ?? item.text ?? item.evidence);
      if (!quote) {
        return undefined;
      }
      return {
        columnName: stringValue(item.columnName ?? item.field) ?? "evidence",
        sourceUrl: stringValue(item.sourceUrl ?? item.url) ?? fallbackSourceUrl,
        quote,
      };
    })
    .filter((item): item is PopulateRuntimeRow["evidence"][number] => Boolean(item));
}

function evidenceFromRow(input: {
  row: Record<string, unknown>;
  cells: Record<string, unknown>;
  fallbackSourceUrl: string;
}): PopulateRuntimeRow["evidence"] {
  const explicitEvidence = evidenceFromUnknown(
    input.row.evidence,
    input.fallbackSourceUrl
  );
  if (explicitEvidence.length > 0) {
    return explicitEvidence;
  }
  const evidenceQuote = stringValue(
    input.cells.evidence_quote ??
    input.cells.evidenceQuote ??
    input.cells.quote
  );
  return evidenceQuote
    ? [{
      columnName: "evidence_quote",
      sourceUrl: input.fallbackSourceUrl,
      quote: evidenceQuote,
    }]
    : [];
}

function browserActionBoxGoal(input: BrowserActionBoxFirstRunInput): string {
  return [
    input.datasetGoalPrompt,
    "",
    "Source URL:",
    input.sourceUrl,
    "",
    "Return JSON with records/rows, source URLs, evidence quotes, and agent_browser_actions when browser actions happen.",
    "Columns:",
    ...input.datasetSchema.columns.map((column) =>
      `- ${column.name}${column.description ? `: ${column.description}` : ""}`
    ),
  ].join("\n");
}

function sourceUrlsFromCells(cells: Record<string, unknown>): string[] {
  return Object.entries(cells)
    .filter(([key]) => /(url|link|website|source)/i.test(key))
    .flatMap(([, value]) => typeof value === "string" ? [value] : []);
}

function uniqueHttpUrls(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => /^https?:\/\//i.test(value))));
}

function normalizeCellValue(value: unknown): PopulateCellValue {
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

function rowHasField(row: unknown, field: string): boolean {
  if (!isRecord(row)) {
    return false;
  }
  const cells = isRecord(row.cells) ? row.cells : isRecord(row.row) ? row.row : row;
  const value = cells[field];
  return value !== undefined && value !== null && value !== "";
}

function rowHasEvidence(row: unknown): boolean {
  if (!isRecord(row)) {
    return false;
  }
  if (arrayValue(row.evidence).some((item) =>
    isRecord(item) && Boolean(stringValue(item.quote ?? item.text))
  )) {
    return true;
  }
  const cells = isRecord(row.cells) ? row.cells : isRecord(row.row) ? row.row : row;
  return Boolean(stringValue(
    cells.evidence_quote ??
    cells.evidenceQuote ??
    cells.quote
  ));
}

function agentCompatibleRows(result: Record<string, unknown>): unknown[] {
  const direct = arrayValue(result.rows ?? result.records ?? result.result);
  if (direct.length > 0) {
    return direct;
  }
  const nested = isRecord(result.result) ? result.result : undefined;
  return nested ? arrayValue(nested.rows ?? nested.records) : [];
}

function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 20_000);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
