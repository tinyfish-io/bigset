import { join } from "node:path";
import { generateRepairDiagnosis } from "../agents/repair-diagnosis.js";
import { generateRepairQueries } from "../agents/repair-queries.js";
import {
  analyzeCoverage,
  countFilledGaps,
  type CoverageReport,
} from "../coverage/analyze.js";
import { config } from "../config.js";
import type { RepairLoopReport } from "../models/schemas.js";
import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";
import {
  recordCoverageGaps,
  recordDiagnosis,
  recordPhaseInMemory,
  type WorkflowMemory,
} from "../memory/index.js";
import {
  markSearchPagesUsed,
  planRepairSearches,
} from "../memory/search-pagination.js";
import { mergeRepairIntoExisting } from "../merge/records.js";
import type { SourcesReport } from "../models/quality.js";
import { buildSourcesReport } from "../quality/index.js";
import { saveJson, type RunPaths } from "../storage/run-store.js";
import { normalizeUrl } from "../utils/url.js";
import {
  entityKeysFromRecords,
  runAcquisitionPhase,
  type AcquisitionResult,
} from "./acquisition.js";
import { explicitBrowserActionsFromAgentRuns } from "./browser-actions.js";

export interface RepairLoopContext {
  userPrompt: string;
  spec: DatasetSpec;
  paths: RunPaths;
  errors: string[];
  memory: WorkflowMemory;
  fetchedUrlSet: Set<string>;
  allSearchQueries: string[];
  allFailedUrls: string[];
  enableTriage: boolean;
  enableTinyfishAgent: boolean;
  agentPollTimeoutMs?: number;
  targetRowCap: number;
  log: (stage: string, message: string) => void;
}

export interface RepairLoopRunResult {
  mergedRecords: ExtractedRecord[];
  unkeyedRecords: ExtractedRecord[];
  coverage: CoverageReport;
  loops: RepairLoopReport[];
  lastDiagnosis?: import("../memory/types.js").RepairDiagnosis;
  repairAcquisitions: AcquisitionResult[];
  sourcesReports: SourcesReport[];
}

export async function runRepairLoops(options: {
  ctx: RepairLoopContext;
  recordsBeforeRepair: ExtractedRecord[];
  initialCoverage: CoverageReport;
  pageIndexStart: number;
}): Promise<RepairLoopRunResult> {
  const { ctx } = options;
  let mergedRecords = options.recordsBeforeRepair;
  let unkeyedRecords: ExtractedRecord[] = [];
  let coverage = options.initialCoverage;
  let pageIndex = options.pageIndexStart;

  const loops: RepairLoopReport[] = [];
  const repairAcquisitions: AcquisitionResult[] = [];
  const sourcesReports: SourcesReport[] = [];
  let lastDiagnosis: import("../memory/types.js").RepairDiagnosis | undefined;

  recordCoverageGaps(ctx.memory, coverage);

  if (!coverage.should_repair) {
    return {
      mergedRecords,
      unkeyedRecords,
      coverage,
      loops,
      repairAcquisitions,
      sourcesReports,
    };
  }

  while (
    coverage.should_repair &&
    ctx.memory.repair_loop_count < config.maxRepairLoops
  ) {
    const loopIndex = ctx.memory.repair_loop_count + 1;
    ctx.memory.repair_loop_count = loopIndex;

    const recordsBeforeLoop = mergedRecords;
    const partialBefore = coverage.partial_count;

    ctx.log(
      "repair",
      `Loop ${loopIndex}/${config.maxRepairLoops} — missing: ${coverage.field_gaps.map((g) => g.column).join(", ")}`,
    );

    const diagnosis = await generateRepairDiagnosis({
      userPrompt: ctx.userPrompt,
      spec: ctx.spec,
      coverage,
      memory: ctx.memory,
      repairLoop: loopIndex,
      maxRepairLoops: config.maxRepairLoops,
    });
    lastDiagnosis = diagnosis;
    recordDiagnosis(ctx.memory, loopIndex, diagnosis);

    await saveJson(
      join(ctx.paths.root, `repair_diagnosis_${loopIndex}.json`),
      diagnosis,
    );

    const repairPlan = await generateRepairQueries({
      userPrompt: ctx.userPrompt,
      spec: ctx.spec,
      coverage,
      priorSearchQueries: ctx.allSearchQueries,
      maxQueries: config.maxRepairQueries,
      memory: ctx.memory,
      diagnosis,
      repairLoop: loopIndex,
    });

    const repairSearches = planRepairSearches(
      ctx.memory,
      repairPlan.repair_queries,
    );
    const paginatedCount = repairSearches.filter((plan) => plan.page > 0).length;

    await saveJson(join(ctx.paths.root, `repair_queries_${loopIndex}.json`), {
      ...repairPlan,
      repair_searches: repairSearches,
    });

    ctx.log(
      "repair",
      `Loop ${loopIndex}: ${repairSearches.length} searches (${repairPlan.repair_queries.length} new, ${paginatedCount} paginated) — ${diagnosis.summary.slice(0, 100)}`,
    );

    const preferAgent =
      diagnosis.prefer_tinyfish_agent && ctx.enableTinyfishAgent;

    const acquisition = await runAcquisitionPhase({
      label: `repair_${loopIndex}`,
      userPrompt: ctx.userPrompt,
      spec: ctx.spec,
      queries: repairSearches.map((plan) => plan.query),
      searches: repairSearches,
      paths: ctx.paths,
      errors: ctx.errors,
      excludeUrls: ctx.fetchedUrlSet,
      maxResultsPerQuery: config.maxRepairResultsPerQuery,
      maxUrlsToFetch: config.maxRepairUrlsToFetch,
      pageIndexStart: pageIndex,
      focusFields: coverage.field_gaps.map((gap) => gap.column),
      knownEntityKeys: entityKeysFromRecords(ctx.spec, recordsBeforeLoop),
      enableTriage: ctx.enableTriage,
      enableTinyfishAgent: ctx.enableTinyfishAgent,
      agentPollTimeoutMs: ctx.agentPollTimeoutMs,
      memory: ctx.memory,
      forceAgent: preferAgent,
      enableLinkFollow: config.enableRepairLinkFollow,
      log: ctx.log,
    });

    markSearchPagesUsed(
      ctx.memory,
      repairSearches,
      `repair_${loopIndex}`,
      loopIndex,
    );

    repairAcquisitions.push(acquisition);
    pageIndex += acquisition.pagesFetched;

    recordPhaseInMemory({
      memory: ctx.memory,
      spec: ctx.spec,
      phase: `repair_${loopIndex}`,
      repairLoop: loopIndex,
      queries: repairSearches.map((plan) => plan.query),
      candidates: acquisition.candidates,
      records: acquisition.records,
      failedUrls: acquisition.failedUrls,
      agentRuns: acquisition.agentRuns,
      triageResults: acquisition.triageResults,
    });

    for (const url of acquisition.fetchedUrls) {
      ctx.fetchedUrlSet.add(normalizeUrl(url));
    }
    ctx.allSearchQueries.push(...repairPlan.repair_queries);
    ctx.allFailedUrls.push(...acquisition.failedUrls);

    sourcesReports.push(
      buildSourcesReport({
        phase: "repair",
        fetchedPages: acquisition.fetchedPages,
        fetchedUrls: acquisition.fetchedUrls,
        triageResults: acquisition.triageResults,
        agentRuns: acquisition.agentRuns,
        agentDeferred: acquisition.agentDeferred,
      }),
    );

    const mergeResult = mergeRepairIntoExisting(
      ctx.spec,
      recordsBeforeLoop,
      acquisition.records,
    );
    mergedRecords = mergeResult.records.slice(0, ctx.targetRowCap);
    unkeyedRecords = [...unkeyedRecords, ...mergeResult.unkeyed];

    const coverageAfter = analyzeCoverage(ctx.spec, mergedRecords);
    await saveJson(
      join(ctx.paths.root, `coverage_repair_${loopIndex}.json`),
      coverageAfter,
    );

    const fieldsFilled = countFilledGaps(
      ctx.spec,
      recordsBeforeLoop,
      mergedRecords,
      coverage.field_gaps.map((gap) => gap.column),
    );

    loops.push({
      loop_index: loopIndex,
      diagnosis_summary: diagnosis.summary,
      repair_queries: repairPlan.repair_queries,
      agent_browser_actions: explicitBrowserActionsFromAgentRuns(
        acquisition.agentRuns
      ),
      rationale: repairPlan.rationale,
      missing_fields: coverage.field_gaps.map((gap) => gap.column),
      records_before: recordsBeforeLoop.length,
      records_after: mergedRecords.length,
      fields_filled: fieldsFilled,
      partial_count_before: partialBefore,
      partial_count_after: coverageAfter.partial_count,
      stats: {
        search_queries_executed: repairSearches.length,
        search_pages_paginated: paginatedCount,
        search_results_collected: acquisition.candidates.length,
        unique_urls_selected: acquisition.fetchedUrls.length,
        pages_fetched: acquisition.pagesFetched,
        pages_failed: acquisition.failedUrls.length,
        raw_records_extracted: acquisition.records.length,
        triage: acquisition.triage,
      },
    });

    ctx.log(
      "repair",
      `Loop ${loopIndex} done — ${mergedRecords.length} records, partial ${partialBefore} → ${coverageAfter.partial_count}`,
    );

    coverage = coverageAfter;
    recordCoverageGaps(ctx.memory, coverage);
  }

  if (coverage.should_repair && ctx.memory.repair_loop_count >= config.maxRepairLoops) {
    ctx.log(
      "repair",
      `Stopped after ${config.maxRepairLoops} repair loops (gaps remain)`,
    );
  }

  return {
    mergedRecords,
    unkeyedRecords,
    coverage,
    loops,
    lastDiagnosis,
    repairAcquisitions,
    sourcesReports,
  };
}
