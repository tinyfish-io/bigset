import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CollectionPopulatePipelineInput,
  CollectionPopulatePipelineRunner,
} from "./populate-collection-runtime.js";
import type {
  PopulateCellValue,
  PopulateRuntimeResult,
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
  report: {
    errors?: string[];
    dataset_spec?: CollectionDatasetSpec;
    stats?: CollectionPhaseStats;
    initial?: CollectionPhaseStats;
    repair?: {
      stats?: CollectionPhaseStats;
    };
    quality?: {
      records?: CollectionRecordQuality[];
    };
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

  return {
    rows,
    validationIssues: [
      ...(input.pipeline.report.errors ?? []),
      ...(rows.length === 0 ? ["No rows returned from collection pipeline."] : []),
    ],
    usage: usageFromPipeline(input.pipeline),
    metrics: metricsFromReport(input.pipeline.report),
  };
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
