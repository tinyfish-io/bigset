import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CollectionPopulatePipelineInput,
  CollectionPopulatePipelineRunner,
} from "./populate-collection-runtime.js";
import {
  populateProcessTraceFromSteps,
  type PopulateCellValue,
  type PopulateRuntimeResult,
  type PopulateRuntimeTraceStep,
} from "./populate-runtime.js";

type CollectionPipelineModule = {
  runPipeline(input: CollectionPipelineOptions): Promise<CollectionPipelineResult>;
};

interface CollectionPipelineOptions {
  prompt: string;
  targetRows: number;
  outputDir: string;
  memoryDir?: string;
  enableRepair?: boolean;
  enableTriage?: boolean;
  enableTinyfishAgent?: boolean;
  agentPollTimeoutMs?: number;
  benchmark?: {
    promptId?: string;
    promptQuality?: string;
    persona?: string;
    expectedStress?: string;
    requiredColumns: string[];
  };
  onLog?: (stage: string, message: string) => void;
}

interface CollectionPipelineResult {
  runId?: string;
  paths?: {
    root?: string;
    reportPath?: string;
  };
  report: {
    errors?: string[];
    dataset_spec?: CollectionDatasetSpec;
    stats?: CollectionPhaseStats;
    initial?: CollectionPhaseStats & {
      search_queries?: string[];
      fetched_urls?: string[];
      failed_urls?: string[];
    };
    repair?: {
      stats?: CollectionPhaseStats;
      loops?: CollectionRepairLoopReport[];
    };
    search_queries?: string[];
    fetched_urls?: string[];
    failed_urls?: string[];
    quality?: {
      records?: CollectionRecordQuality[];
    };
    sources?: CollectionSourcesReport;
    llm_usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  records?: CollectionExtractedRecord[];
  visualizationRecords?: CollectionExtractedRecord[];
  llmUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface CollectionDatasetSpec {
  columns?: Array<{ name: string }>;
  dedupe_keys?: string[];
}

interface CollectionPhaseStats {
  search_queries_executed?: number;
  pages_fetched?: number;
  triage?: {
    agent_dispatched?: number;
    agent_succeeded?: number;
    agent_failed?: number;
  };
}

interface CollectionExtractedRecord {
  row?: Record<string, PopulateCellValue>;
  source_urls?: string[];
  evidence?: Array<{
    field?: string;
    url?: string;
    quote?: string;
  }>;
}

interface CollectionRecordQuality {
  record_id?: string;
  needs_review?: boolean;
}

interface CollectionSourcesReport {
  outcomes?: CollectionSourceOutcome[];
}

interface CollectionSourceOutcome {
  url?: string;
  phase?: string;
  outcome?: string;
  triage_status?: string;
  error?: string;
  records_extracted?: number;
}

interface CollectionRepairLoopReport {
  loop_index?: number;
  repair_queries?: string[];
  stats?: CollectionPhaseStats;
}

const AGENT_REQUIRED_TRIAGE_STATUSES = new Set([
  "requires_navigation",
  "requires_form_submission",
  "requires_detail_page_followup",
]);

const DEFAULT_COLLECTION_AGENT_POLL_TIMEOUT_MS = 480_000;

export const runCollectionPopulatePipeline: CollectionPopulatePipelineRunner =
  async (input) => {
    const outputDir = await mkdtemp(join(tmpdir(), "bigset-collection-"));
    const enableTinyfishAgent = boolEnv("COLLECTION_AGENT_ENABLE_AGENT", false);
    const pipeline = await loadCollectionPipelineModule();
    const result = await pipeline.runPipeline({
      prompt: input.prompt,
      targetRows: input.targetRows,
      outputDir,
      memoryDir: join(outputDir, "memory"),
      enableRepair: boolEnv("COLLECTION_AGENT_ENABLE_REPAIR", false),
      enableTriage: boolEnv("COLLECTION_AGENT_ENABLE_TRIAGE", true),
      enableTinyfishAgent,
      agentPollTimeoutMs: enableTinyfishAgent
        ? collectionAgentPollTimeoutMs()
        : undefined,
      benchmark: benchmarkContextFromInput(input),
      onLog: (stage, message) => {
        console.error(`[collection:${stage}] ${message}`);
      },
    });

    return collectionPipelineResultToPopulateRuntimeResult({
      pipeline: result,
      requiredColumns: input.requiredColumns,
      enableTinyfishAgent,
    });
  };

async function loadCollectionPipelineModule(): Promise<CollectionPipelineModule> {
  const moduleSpecifier = process.env.COLLECTION_AGENT_PIPELINE_MODULE;
  if (!moduleSpecifier) {
    throw new Error(
      "COLLECTION_AGENT_PIPELINE_MODULE must point to the collection pipeline module exporting runPipeline(options)."
    );
  }
  const moduleUrl = moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")
    ? pathToFileURL(resolve(moduleSpecifier)).href
    : moduleSpecifier;
  const loadedModule = await import(moduleUrl);
  if (typeof loadedModule.runPipeline !== "function") {
    throw new Error(
      `${moduleSpecifier} must export runPipeline(options).`
    );
  }
  return loadedModule as CollectionPipelineModule;
}

function benchmarkContextFromInput(input: CollectionPopulatePipelineInput) {
  if (input.requiredColumns.length === 0) {
    return undefined;
  }
  return {
    promptId: input.promptId,
    promptQuality: input.promptQuality,
    persona: input.persona,
    expectedStress: input.expectedStress,
    requiredColumns: input.requiredColumns,
  };
}

function collectionPipelineResultToPopulateRuntimeResult(input: {
  pipeline: CollectionPipelineResult;
  requiredColumns: string[];
  enableTinyfishAgent: boolean;
}): PopulateRuntimeResult {
  const records = selectOutputRecords(input.pipeline);
  const qualityById = qualityByRecordId(input.pipeline.report.quality?.records);
  const rows = records.map((record) =>
    collectionRecordToPopulateRow({
      record,
      spec: input.pipeline.report.dataset_spec,
      requiredColumns: input.requiredColumns,
      qualityById,
    })
  );
  const capabilityDiagnostics = capabilityDiagnosticsFromReport({
    report: input.pipeline.report,
    enableTinyfishAgent: input.enableTinyfishAgent,
  });

  return {
    rows,
    validationIssues: [
      ...(input.pipeline.report.errors ?? []),
      ...capabilityDiagnostics,
      ...(rows.length === 0 ? ["No rows returned from collection pipeline."] : []),
    ],
    usage: usageFromPipeline(input.pipeline),
    metrics: metricsFromReport(input.pipeline.report),
    debug: {
      capturedRows: [],
      capturedSources: [],
      selectedRowSource: rows.length > 0 ? "collection_pipeline" : "none",
      notes: collectionDebugNotes(input.pipeline.report),
      processTrace: collectionProcessTrace({
        pipeline: input.pipeline,
        rows,
      }),
    },
  };
}

function capabilityDiagnosticsFromReport(input: {
  report: CollectionPipelineResult["report"];
  enableTinyfishAgent: boolean;
}): string[] {
  if (input.enableTinyfishAgent) {
    return [];
  }
  const agentRequiredOutcomes = (input.report.sources?.outcomes ?? []).filter(
    isAgentRequiredSourceOutcome
  );
  if (agentRequiredOutcomes.length === 0) {
    return [];
  }

  const statusCounts = new Map<string, number>();
  for (const outcome of agentRequiredOutcomes) {
    const status = outcome.triage_status as string;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const statusSummary = Array.from(statusCounts.entries())
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");

  return [
    `Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up for ${agentRequiredOutcomes.length} page(s) (${statusSummary}). Enable COLLECTION_AGENT_ENABLE_AGENT=true for live navigation.`,
  ];
}

function collectionProcessTrace(input: {
  pipeline: CollectionPipelineResult;
  rows: Array<ReturnType<typeof collectionRecordToPopulateRow>>;
}) {
  const report = input.pipeline.report;
  const steps: PopulateRuntimeTraceStep[] = [];

  for (const query of report.search_queries ?? report.initial?.search_queries ?? []) {
    steps.push({
      kind: "search",
      label: "collection-search-query",
      status: "succeeded",
      input: { query },
    });
  }

  for (const url of report.fetched_urls ?? report.initial?.fetched_urls ?? []) {
    steps.push({
      kind: "fetch",
      label: "collection-fetched-url",
      status: "succeeded",
      input: { url },
    });
  }

  for (const url of report.failed_urls ?? report.initial?.failed_urls ?? []) {
    steps.push({
      kind: "fetch",
      label: "collection-failed-url",
      status: "failed",
      input: { url },
    });
  }

  for (const loop of report.repair?.loops ?? []) {
    for (const query of loop.repair_queries ?? []) {
      steps.push({
        kind: "repair",
        label: "collection-repair-query",
        status: "succeeded",
        input: {
          loopIndex: loop.loop_index,
          query,
        },
      });
    }
  }

  for (const outcome of report.sources?.outcomes ?? []) {
    if (!outcome.url) {
      continue;
    }
    steps.push({
      kind: sourceOutcomeTraceKind(outcome),
      label: `collection-source-${outcome.outcome ?? "unknown"}`,
      status: sourceOutcomeTraceStatus(outcome),
      input: {
        url: outcome.url,
        phase: outcome.phase,
        triageStatus: outcome.triage_status,
      },
      output: {
        recordsExtracted: outcome.records_extracted,
      },
      error: outcome.error,
    });
  }

  return populateProcessTraceFromSteps({
    runtime: "collection",
    steps,
    selectedRowSource: input.rows.length > 0 ? "collection_pipeline" : "none",
    notes: collectionDebugNotes(report),
    artifactRoot: input.pipeline.paths?.root,
    runReportPath: input.pipeline.paths?.reportPath,
  });
}

function collectionDebugNotes(report: CollectionPipelineResult["report"]): string[] {
  const notes = [];
  if (report.stats) {
    notes.push(
      `collection stats: searches=${numberValue(report.stats.search_queries_executed)}, ` +
        `fetches=${numberValue(report.stats.pages_fetched)}`
    );
  }
  if (report.repair?.loops && report.repair.loops.length > 0) {
    notes.push(`collection repair loops=${report.repair.loops.length}`);
  }
  return notes;
}

function sourceOutcomeTraceKind(outcome: CollectionSourceOutcome): PopulateRuntimeTraceStep["kind"] {
  if (outcome.outcome?.startsWith("agent_")) {
    return "agent";
  }
  if (outcome.outcome === "fetch_failed") {
    return "fetch";
  }
  return "validation";
}

function sourceOutcomeTraceStatus(
  outcome: CollectionSourceOutcome
): PopulateRuntimeTraceStep["status"] {
  if (
    outcome.outcome &&
    ["fetch_failed", "skipped", "agent_failed", "agent_deferred", "no_records"].includes(
      outcome.outcome
    )
  ) {
    return "failed";
  }
  return "succeeded";
}

function isAgentRequiredSourceOutcome(outcome: CollectionSourceOutcome): boolean {
  return (
    typeof outcome.triage_status === "string" &&
    AGENT_REQUIRED_TRIAGE_STATUSES.has(outcome.triage_status) &&
    outcome.outcome !== "success"
  );
}

function selectOutputRecords(
  pipeline: CollectionPipelineResult
): CollectionExtractedRecord[] {
  if (pipeline.visualizationRecords && pipeline.visualizationRecords.length > 0) {
    return pipeline.visualizationRecords;
  }
  return pipeline.records ?? [];
}

function collectionRecordToPopulateRow(input: {
  record: CollectionExtractedRecord;
  spec?: CollectionDatasetSpec;
  requiredColumns: string[];
  qualityById: Map<string, CollectionRecordQuality>;
}) {
  const cells: Record<string, PopulateCellValue> = {
    ...(input.record.row ?? {}),
  };
  for (const columnName of input.requiredColumns) {
    if (cells[columnName] === undefined) {
      cells[columnName] = null;
    }
  }

  const sourceUrls = uniqueHttpUrls(input.record.source_urls ?? []);
  const evidence = (input.record.evidence ?? [])
    .map((item) => ({
      columnName: item.field ?? "",
      sourceUrl: item.url || sourceUrls[0] || "",
      quote: item.quote ?? "",
    }))
    .filter((item) => item.columnName && item.quote);
  const recordId = canonicalRecordId(input.record, input.spec);
  const quality = recordId ? input.qualityById.get(recordId) : undefined;

  return {
    cells,
    sourceUrls,
    evidence,
    needsReview: quality?.needs_review ?? false,
  };
}

function qualityByRecordId(
  records: CollectionRecordQuality[] = []
): Map<string, CollectionRecordQuality> {
  return new Map(
    records
      .filter((record) => record.record_id)
      .map((record) => [record.record_id as string, record])
  );
}

function canonicalRecordId(
  record: CollectionExtractedRecord,
  spec?: CollectionDatasetSpec
): string | undefined {
  const primaryKey =
    spec?.dedupe_keys?.[0] ??
    spec?.columns?.find((column) =>
      /(name|title|company|organization|entity)/i.test(column.name)
    )?.name ??
    spec?.columns?.[0]?.name;
  if (!primaryKey) {
    return undefined;
  }
  const value = normalizePrimaryKey(record.row?.[primaryKey]);
  return value ? `pk:${value}` : undefined;
}

function usageFromPipeline(pipeline: CollectionPipelineResult) {
  const scopedUsage = pipeline.llmUsage;
  if (scopedUsage?.totalTokens) {
    return {
      promptTokens: scopedUsage.promptTokens ?? 0,
      completionTokens: scopedUsage.completionTokens ?? 0,
      totalTokens: scopedUsage.totalTokens ?? 0,
    };
  }
  const reportUsage = pipeline.report.llm_usage;
  return {
    promptTokens: reportUsage?.prompt_tokens ?? 0,
    completionTokens: reportUsage?.completion_tokens ?? 0,
    totalTokens: reportUsage?.total_tokens ?? 0,
  };
}

function metricsFromReport(report: CollectionPipelineResult["report"]) {
  const stats = report.stats ?? {};
  const initialTriage = report.initial?.triage ?? {};
  const repairTriage = report.repair?.stats?.triage ?? {};
  const agentDispatched =
    numberValue(initialTriage.agent_dispatched) +
      numberValue(repairTriage.agent_dispatched);

  return {
    searchCalls: numberValue(stats.search_queries_executed),
    fetchCalls: numberValue(stats.pages_fetched),
    browserCalls: agentDispatched,
    agentRuns: agentDispatched,
    agentSteps:
      numberValue(initialTriage.agent_succeeded) +
      numberValue(initialTriage.agent_failed) +
      numberValue(repairTriage.agent_succeeded) +
      numberValue(repairTriage.agent_failed),
  };
}

function uniqueHttpUrls(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
    )
  );
}

function normalizePrimaryKey(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected positive integer, got "${raw}"`);
  }
  return value;
}

function optionalIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected positive integer, got "${raw}"`);
  }
  return value;
}

function collectionAgentPollTimeoutMs(): number {
  return optionalIntEnv("AGENT_POLL_TIMEOUT_MS") ??
    intEnv(
      "COLLECTION_AGENT_POLL_TIMEOUT_MS",
      DEFAULT_COLLECTION_AGENT_POLL_TIMEOUT_MS
    );
}
