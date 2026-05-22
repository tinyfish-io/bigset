import { runWithLlmUsageScope, getCurrentLlmUsage, type LlmUsageTotals } from "../llm/usage.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { generateDatasetSpec } from "../agents/dataset-spec.js";
import type { BenchmarkSpecContext } from "../agents/benchmark-spec.js";
import {
  analyzeCoverage,
  type CoverageReport,
} from "../coverage/analyze.js";
import { assertConfig, config } from "../config.js";
import { selectVisualizationRecords } from "../export/select-results.js";
import {
  qualityMapFromReport,
  writeEvidenceJsonl,
  writeResultsCsv,
  writeSegmentedRecordCsvs,
  writeUnkeyedRecordsJsonl,
} from "../export/csv-compiler.js";
import { mergeRecords, mergeRepairIntoExisting } from "../merge/records.js";
import type { DatasetSpec, ExtractedRecord, RunReport } from "../models/schemas.js";
import {
  createWorkflowMemory,
  loadPersistentMemory,
  mergePersistentMemory,
  recordCoverageGaps,
  recordPhaseInMemory,
  savePersistentMemory,
  saveRunMemory,
  snapshotExtractionSchema,
  type WorkflowMemory,
} from "../memory/index.js";
import {
  agentExtractedUrls,
  buildQualityReport,
  buildSourcesReport,
  mergeSourcesReports,
  triageByUrl,
} from "../quality/index.js";
import { entityKeysFromRecords, runAcquisitionPhase } from "./acquisition.js";
import { runRepairLoops } from "./repair-loop.js";
import { loadRunForRefresh, type LoadedRun } from "../storage/run-loader.js";
import {
  createRunStore,
  saveDatasetSpec,
  saveJson,
  saveRunReport,
  saveSourceCandidates,
  type RunPaths,
} from "../storage/run-store.js";
import { normalizeUrl } from "../utils/url.js";

export interface PipelineOptions {
  prompt: string;
  targetRows: number;
  outputDir: string;
  memoryDir?: string;
  enableRepair?: boolean;
  enableTriage?: boolean;
  enableTinyfishAgent?: boolean;
  /** Recurring refresh: baseline run to merge into (in-place by primary key). */
  refreshFrom?: LoadedRun;
  /** Overwrite the source run directory (same run_id). */
  refreshInPlace?: boolean;
  /** When refreshing, re-fetch URLs already seen in the source run. */
  refetchUrls?: boolean;
  /** Per-run TinyFish Agent poll timeout. Defaults to vendored config. */
  agentPollTimeoutMs?: number;
  /** Override pipeline logging (benchmark adapters should log to stderr). */
  onLog?: (stage: string, message: string) => void;
  /** Set when invoked from the dataset-agent benchmark harness. */
  benchmark?: BenchmarkSpecContext;
}

export interface PipelineResult {
  runId: string;
  paths: RunPaths;
  report: RunReport;
  recordCount: number;
  records: ExtractedRecord[];
  visualizationRecords: ExtractedRecord[];
  llmUsage: LlmUsageTotals;
}

let pipelineLog: (stage: string, message: string) => void = (stage, message) => {
  console.log(`[${stage}] ${message}`);
};

function log(stage: string, message: string): void {
  pipelineLog(stage, message);
}

function phaseStatsFromAcquisition(
  acquisition: {
    candidates: { length: number };
    fetchedUrls: string[];
    failedUrls: string[];
    records: ExtractedRecord[];
    pagesFetched: number;
    triage: import("../models/schemas.js").TriageSummary;
  },
  queryCount: number,
) {
  return {
    search_queries_executed: queryCount,
    search_results_collected: acquisition.candidates.length,
    unique_urls_selected: acquisition.fetchedUrls.length,
    pages_fetched: acquisition.pagesFetched,
    pages_failed: acquisition.failedUrls.length,
    raw_records_extracted: acquisition.records.length,
    triage: acquisition.triage,
  };
}

function emptyRepairStats(): RunReport["repair"]["stats"] {
  return {
    search_queries_executed: 0,
    search_results_collected: 0,
    unique_urls_selected: 0,
    pages_fetched: 0,
    pages_failed: 0,
    raw_records_extracted: 0,
    triage: {
      pages_triaged: 0,
      by_status: {},
      extract_now: 0,
      agent_candidates: 0,
      agent_dispatched: 0,
      agent_deferred: 0,
      agent_succeeded: 0,
      agent_failed: 0,
      skipped: 0,
      records_from_extract: 0,
      records_from_agent: 0,
    },
  };
}

function aggregateRepairStats(
  loops: RunReport["repair"]["loops"],
): RunReport["repair"]["stats"] {
  const stats = emptyRepairStats();
  for (const loop of loops) {
    stats.search_queries_executed += loop.stats.search_queries_executed;
    stats.search_results_collected += loop.stats.search_results_collected;
    stats.unique_urls_selected += loop.stats.unique_urls_selected;
    stats.pages_fetched += loop.stats.pages_fetched;
    stats.pages_failed += loop.stats.pages_failed;
    stats.raw_records_extracted += loop.stats.raw_records_extracted;
  }
  return stats;
}

function memoryDirFor(options: PipelineOptions): string {
  return options.memoryDir ?? join(options.outputDir, "..", "memory");
}

export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { result, usage } = await runWithLlmUsageScope(() =>
    executeRunPipeline(options),
  );
  return { ...result, llmUsage: usage };
}

async function executeRunPipeline(
  options: PipelineOptions,
): Promise<Omit<PipelineResult, "llmUsage">> {
  pipelineLog =
    options.onLog ?? ((stage, message) => console.log(`[${stage}] ${message}`));
  assertConfig();

  const enableRepair = options.enableRepair ?? config.enableRepairLoop;
  const enableTriage = options.enableTriage ?? config.enableTriage;
  const enableTinyfishAgent =
    options.enableTinyfishAgent ?? config.enableTinyfishAgent;
  const useMemory = config.enableWorkflowMemory;
  const startedAt = new Date();
  const refreshSource = options.refreshFrom;
  const inPlaceRefresh = Boolean(refreshSource && options.refreshInPlace);
  const runId =
    inPlaceRefresh && refreshSource
      ? refreshSource.runId
      : randomUUID().slice(0, 8);
  const paths = await createRunStore(options.outputDir, runId);
  const errors: string[] = [];
  const fetchedUrlSet = new Set<string>();
  if (refreshSource && !options.refetchUrls) {
    for (const url of refreshSource.report.fetched_urls) {
      fetchedUrlSet.add(normalizeUrl(url));
    }
  }
  let pageIndex = 0;
  const targetRowCap = options.targetRows * 2;

  log(
    "init",
    refreshSource
      ? `refresh run_id=${runId} from=${refreshSource.runId} in_place=${inPlaceRefresh} output=${paths.root}`
      : `run_id=${runId} output=${paths.root}`,
  );

  let memory: WorkflowMemory = createWorkflowMemory(options.prompt);
  if (refreshSource?.memory) {
    memory = mergePersistentMemory(memory, refreshSource.memory);
    log(
      "memory",
      `Loaded workflow memory from run ${refreshSource.runId} (${refreshSource.memory.query_stats.length} query stats)`,
    );
  }
  if (useMemory) {
    const prior = await loadPersistentMemory(
      memoryDirFor(options),
      memory.prompt_fingerprint,
    );
    memory = mergePersistentMemory(memory, prior);
    if (prior && !refreshSource?.memory) {
      log(
        "memory",
        `Loaded prior workflow memory (${prior.query_stats.length} query stats, ${prior.domain_stats.length} domain stats)`,
      );
    }
  }

  let spec: DatasetSpec;
  let baselineRecords: ExtractedRecord[] = [];

  if (refreshSource) {
    spec = refreshSource.spec;
    baselineRecords = refreshSource.records;
    memory.extraction_schema = snapshotExtractionSchema(spec);
    memory.dedupe_keys = spec.dedupe_keys;
    memory.repair_loop_count = 0;
    await saveDatasetSpec(paths, spec);
    log(
      "refresh",
      `Baseline ${baselineRecords.length} records — new search with prior diagnostics/memory`,
    );
  } else {
    log("spec", "Generating dataset specification...");
    spec = await generateDatasetSpec(
      options.prompt,
      options.targetRows,
      useMemory ? memory : null,
      options.benchmark,
    );
    memory.extraction_schema = snapshotExtractionSchema(spec);
    memory.dedupe_keys = spec.dedupe_keys;
    await saveDatasetSpec(paths, spec);
  }

  const initialQueries = spec.search_queries.slice(0, config.maxSearchQueries);

  const initialAcquisition = await runAcquisitionPhase({
    label: refreshSource ? "refresh" : "initial",
    userPrompt: options.prompt,
    spec,
    queries: initialQueries,
    paths,
    errors,
    excludeUrls: fetchedUrlSet,
    maxResultsPerQuery: config.maxResultsPerQuery,
    maxUrlsToFetch: config.maxUrlsToFetch,
    pageIndexStart: pageIndex,
    enableTriage,
    enableTinyfishAgent,
    agentPollTimeoutMs: options.agentPollTimeoutMs,
    memory: useMemory ? memory : undefined,
    log,
  });

  recordPhaseInMemory({
    memory,
    spec,
    phase: refreshSource ? "refresh" : "initial",
    repairLoop: 0,
    queries: initialQueries,
    candidates: initialAcquisition.candidates,
    records: initialAcquisition.records,
    failedUrls: initialAcquisition.failedUrls,
    agentRuns: initialAcquisition.agentRuns,
    triageResults: initialAcquisition.triageResults,
  });

  if (initialAcquisition.triage.agent_dispatched > 0) {
    log(
      "triage",
      `Initial: ${initialAcquisition.triage.extract_now} extract_now, ` +
        `${initialAcquisition.triage.agent_succeeded}/${initialAcquisition.triage.agent_dispatched} agent runs succeeded`,
    );
  }

  for (const url of initialAcquisition.fetchedUrls) {
    fetchedUrlSet.add(normalizeUrl(url));
  }
  pageIndex += initialAcquisition.pagesFetched;

  await saveSourceCandidates(paths, initialAcquisition.candidates);

  let mergeResult = refreshSource
    ? mergeRepairIntoExisting(
        spec,
        baselineRecords,
        initialAcquisition.records,
      )
    : mergeRecords(spec, initialAcquisition.records);
  let mergedRecords = mergeResult.records.slice(0, targetRowCap);
  let benchmarkVisualizationRecords = mergedRecords;
  let unkeyedRecords = mergeResult.unkeyed;

  let coverage: CoverageReport = analyzeCoverage(spec, mergedRecords);
  recordCoverageGaps(memory, coverage);
  await saveJson(join(paths.root, "coverage_initial.json"), coverage);

  const writeExports = async (
    csvPath: string,
    evidencePath: string,
    records: ExtractedRecord[],
    qualityById?: ReturnType<typeof qualityMapFromReport>,
  ) => {
    await writeResultsCsv(csvPath, spec, records, qualityById);
    await writeEvidenceJsonl(evidencePath, spec, records, qualityById);
  };

  log("export", `Writing init_results.csv (${mergedRecords.length} records)...`);
  await writeExports(paths.initResultsPath, paths.initEvidencePath, mergedRecords);

  const allSearchQueries = [...initialQueries];
  const allFailedUrls = [...initialAcquisition.failedUrls];
  const recordsBeforeRepair = mergedRecords;

  let repairReport: RunReport["repair"] = {
    attempted: false,
    total_loops: 0,
    loops: [],
    missing_fields: [],
    repair_queries: [],
    records_before: mergedRecords.length,
    records_after: mergedRecords.length,
    fields_filled: {},
    stats: emptyRepairStats(),
  };

  const repairAcquisitions: typeof initialAcquisition[] = [];

  if (!enableRepair) {
    repairReport.skipped_reason = "repair_disabled";
    log("repair", "Skipped (disabled)");
  } else if (!coverage.should_repair) {
    repairReport.skipped_reason = "no_missing_required_fields";
    log(
      "repair",
      `Skipped (coverage satisfied) — required=[${coverage.required_columns.join(", ")}]`,
    );
  } else {
    repairReport.attempted = true;
    repairReport.records_before = recordsBeforeRepair.length;
    repairReport.missing_fields = coverage.field_gaps.map((gap) => gap.column);

    const repairResult = await runRepairLoops({
      ctx: {
        userPrompt: options.prompt,
        spec,
        paths,
        errors,
        memory,
        fetchedUrlSet,
        allSearchQueries,
        allFailedUrls,
        enableTriage,
        enableTinyfishAgent,
        agentPollTimeoutMs: options.agentPollTimeoutMs,
        targetRowCap,
        log,
      },
      recordsBeforeRepair,
      initialCoverage: coverage,
      pageIndexStart: pageIndex,
    });

    mergedRecords = repairResult.mergedRecords;
    unkeyedRecords = [...unkeyedRecords, ...repairResult.unkeyedRecords];
    coverage = repairResult.coverage;
    repairAcquisitions.push(...repairResult.repairAcquisitions);

    repairReport.total_loops = repairResult.loops.length;
    repairReport.loops = repairResult.loops;
    repairReport.last_diagnosis = repairResult.lastDiagnosis;
    repairReport.records_after = mergedRecords.length;
    repairReport.repair_queries = repairResult.loops.flatMap((loop) => loop.repair_queries);
    repairReport.rationale = repairResult.lastDiagnosis?.summary;
    repairReport.fields_filled = repairResult.loops.reduce(
      (acc, loop) => {
        for (const [key, value] of Object.entries(loop.fields_filled)) {
          acc[key] = (acc[key] ?? 0) + value;
        }
        return acc;
      },
      {} as Record<string, number>,
    );
    repairReport.stats = aggregateRepairStats(repairResult.loops);
    repairReport.missing_fields = coverage.field_gaps.map((gap) => gap.column);

    if (repairResult.loops.length > 0) {
      log(
        "export",
        `Writing repair_results.csv (${mergedRecords.length} records after ${repairResult.loops.length} repair loop(s))...`,
      );
      await writeExports(
        paths.repairResultsPath,
        paths.repairEvidencePath,
        mergedRecords,
      );
    }
  }

  if (useMemory) {
    await saveRunMemory(paths.root, memory);
    await savePersistentMemory(memoryDirFor(options), memory);
    log("memory", `Saved workflow memory (repair_loops=${memory.repair_loop_count})`);
  }

  let qualityReport: RunReport["quality"];
  let sourcesReport: RunReport["sources"];

  if (config.enableQualityScoring) {
    log("quality", "Scoring records and building source outcomes...");

    const allTriage = [
      ...initialAcquisition.triageResults,
      ...repairAcquisitions.flatMap((a) => a.triageResults),
    ];
    const allAgentRuns = [
      ...initialAcquisition.agentRuns,
      ...repairAcquisitions.flatMap((a) => a.agentRuns),
    ];

    const scoreContext = {
      triageByUrl: triageByUrl(allTriage),
      agentExtractedUrls: agentExtractedUrls(allAgentRuns),
    };

    qualityReport = buildQualityReport(
      spec,
      mergedRecords,
      scoreContext,
      unkeyedRecords.length,
    );

    const initialSources = buildSourcesReport({
      phase: "initial",
      fetchedPages: initialAcquisition.fetchedPages,
      fetchedUrls: initialAcquisition.fetchedUrls,
      triageResults: initialAcquisition.triageResults,
      agentRuns: initialAcquisition.agentRuns,
      agentDeferred: initialAcquisition.agentDeferred,
    });

    const repairSourcesList = repairAcquisitions.map((acquisition, index) =>
      buildSourcesReport({
        phase: "repair",
        fetchedPages: acquisition.fetchedPages,
        fetchedUrls: acquisition.fetchedUrls,
        triageResults: acquisition.triageResults,
        agentRuns: acquisition.agentRuns,
        agentDeferred: acquisition.agentDeferred,
      }),
    );

    sourcesReport = repairSourcesList.reduce(
      (acc, report) => mergeSourcesReports(acc, report),
      initialSources,
    );

    await saveJson(join(paths.root, "quality_report.json"), qualityReport);
    await saveJson(join(paths.root, "sources_outcomes.json"), sourcesReport);

    if (unkeyedRecords.length > 0) {
      await writeUnkeyedRecordsJsonl(
        join(paths.root, "records_unkeyed.jsonl"),
        unkeyedRecords,
      );
    }

    await writeSegmentedRecordCsvs(
      paths.root,
      spec,
      mergedRecords,
      qualityReport.records,
    );

    const qualityById = qualityMapFromReport(qualityReport.records);
    benchmarkVisualizationRecords = config.enableSelectiveResults
      ? selectVisualizationRecords(spec, mergedRecords, qualityById)
      : mergedRecords;

    log(
      "quality",
      `complete=${qualityReport.complete.count} partial=${qualityReport.partial.count} ` +
        `low_confidence=${qualityReport.low_confidence.count} needs_review=${qualityReport.needs_review.count} ` +
        `visualization=${benchmarkVisualizationRecords.length}`,
    );

    if (config.enableSelectiveResults) {
      log(
        "export",
        `Writing results_full.csv (${mergedRecords.length} records)...`,
      );
      await writeExports(
        paths.resultsFullPath,
        paths.evidenceFullPath,
        mergedRecords,
        qualityById,
      );
      log(
        "export",
        `Writing results.csv (${benchmarkVisualizationRecords.length} selective records)...`,
      );
      await writeExports(
        paths.resultsPath,
        paths.evidencePath,
        benchmarkVisualizationRecords,
        qualityById,
      );
    } else {
      log("export", `Writing results.csv (${mergedRecords.length} records)...`);
      await writeExports(
        paths.resultsPath,
        paths.evidencePath,
        mergedRecords,
        qualityById,
      );
    }
  } else {
    log("export", `Writing results.csv (${mergedRecords.length} records)...`);
    await writeExports(paths.resultsPath, paths.evidencePath, mergedRecords);
  }

  const finishedAt = new Date();
  const initialStats = phaseStatsFromAcquisition(
    initialAcquisition,
    initialQueries.length,
  );

  const visualizationCount = benchmarkVisualizationRecords.length;

  const llmUsage = getCurrentLlmUsage();

  const report: RunReport = {
    run_id: runId,
    ...(refreshSource
      ? {
          refreshed_from_run_id: refreshSource.runId,
          refresh_in_place: inPlaceRefresh,
        }
      : {}),
    prompt: options.prompt,
    target_rows: options.targetRows,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    dataset_spec: spec,
    stats: {
      ...initialStats,
      search_queries_executed:
        initialStats.search_queries_executed +
        repairReport.stats.search_queries_executed,
      search_results_collected:
        initialStats.search_results_collected +
        repairReport.stats.search_results_collected,
      unique_urls_selected:
        initialStats.unique_urls_selected +
        repairReport.stats.unique_urls_selected,
      pages_fetched:
        initialStats.pages_fetched + repairReport.stats.pages_fetched,
      pages_failed:
        initialStats.pages_failed + repairReport.stats.pages_failed,
      raw_records_extracted:
        initialStats.raw_records_extracted +
        repairReport.stats.raw_records_extracted,
      records_after_merge: mergedRecords.length,
      visualization_records: visualizationCount,
    },
    initial: {
      ...initialStats,
      search_queries: initialQueries,
      fetched_urls: initialAcquisition.fetchedUrls,
      failed_urls: initialAcquisition.failedUrls,
    },
    repair: repairReport,
    search_queries: allSearchQueries,
    fetched_urls: [...fetchedUrlSet],
    failed_urls: allFailedUrls,
    errors,
    quality: qualityReport,
    sources: sourcesReport,
    llm_usage: {
      prompt_tokens: llmUsage.promptTokens,
      completion_tokens: llmUsage.completionTokens,
      total_tokens: llmUsage.totalTokens,
      call_count: llmUsage.callCount,
    },
  };

  await saveRunReport(paths, report);

  log("done", `results → ${paths.resultsPath}`);
  return {
    runId,
    paths,
    report,
    recordCount: mergedRecords.length,
    records: mergedRecords,
    visualizationRecords: benchmarkVisualizationRecords,
  };
}

export function defaultRunsDir(): string {
  return join(process.cwd(), "runs");
}

export function defaultMemoryDir(): string {
  return join(process.cwd(), "memory");
}

export async function runRefreshPipeline(options: {
  fromRunId: string;
  outputDir: string;
  memoryDir?: string;
  targetRows?: number;
  inPlace?: boolean;
  refetchUrls?: boolean;
  enableRepair?: boolean;
  enableTriage?: boolean;
  enableTinyfishAgent?: boolean;
}): Promise<PipelineResult> {
  const loaded = await loadRunForRefresh(options.outputDir, options.fromRunId);
  if (loaded.records.length === 0) {
    throw new Error(
      `Run ${options.fromRunId} has no records in evidence.jsonl — cannot refresh`,
    );
  }

  return runPipeline({
    prompt: loaded.report.prompt,
    targetRows: options.targetRows ?? loaded.report.target_rows,
    outputDir: options.outputDir,
    memoryDir: options.memoryDir,
    enableRepair: options.enableRepair,
    enableTriage: options.enableTriage,
    enableTinyfishAgent: options.enableTinyfishAgent,
    refreshFrom: loaded,
    refreshInPlace: options.inPlace,
    refetchUrls: options.refetchUrls,
  });
}
