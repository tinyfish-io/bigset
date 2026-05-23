import type {
  QualityBucket,
  QualityReport,
  SourceOutcome,
  SourcesReport,
} from "../models/quality.js";
import type {
  AgentRunRecord,
  DatasetSpec,
  ExtractedRecord,
  FetchedPage,
  SourceTriageResult,
} from "../models/schemas.js";
import { statusNeedsAgent } from "../models/source-status.js";
import { normalizeUrl } from "../utils/url.js";
import { scoreRecords, type ScoreRecordContext } from "./score-record.js";

function bucket(recordIds: string[]): QualityBucket {
  return { count: recordIds.length, record_ids: recordIds };
}

export function buildQualityReport(
  spec: DatasetSpec,
  records: ExtractedRecord[],
  context: ScoreRecordContext,
  unkeyedCount: number,
): QualityReport {
  const scored = scoreRecords(spec, records, context);

  const completeIds: string[] = [];
  const partialIds: string[] = [];
  const lowConfidenceIds: string[] = [];
  const reviewIds: string[] = [];

  for (const quality of scored) {
    if (quality.record_status === "complete") completeIds.push(quality.record_id);
    if (quality.record_status === "partial") partialIds.push(quality.record_id);
    if (quality.record_status === "low_confidence") {
      lowConfidenceIds.push(quality.record_id);
    }
    if (quality.needs_review) reviewIds.push(quality.record_id);
  }

  return {
    total_records: records.length,
    unkeyed_records: unkeyedCount,
    complete: bucket(completeIds),
    partial: bucket(partialIds),
    low_confidence: bucket(lowConfidenceIds),
    needs_review: bucket(reviewIds),
    records: scored,
  };
}

export function triageByUrl(
  triageResults: SourceTriageResult[],
): Map<string, SourceTriageResult> {
  const map = new Map<string, SourceTriageResult>();
  for (const triage of triageResults) {
    map.set(normalizeUrl(triage.final_url), triage);
    map.set(normalizeUrl(triage.url), triage);
  }
  return map;
}

export function agentExtractedUrls(
  agentRuns: AgentRunRecord[],
): Set<string> {
  return new Set(
    agentRuns
      .filter((run) => run.records_extracted > 0 && !run.error)
      .map((run) => normalizeUrl(run.url)),
  );
}

const SKIPPED_STATUSES = new Set([
  "irrelevant",
  "duplicate",
  "blocked",
  "low_value",
]);

export interface BuildSourcesOptions {
  phase: "initial" | "repair";
  fetchedPages: FetchedPage[];
  fetchedUrls: string[];
  triageResults: SourceTriageResult[];
  agentRuns: AgentRunRecord[];
  agentDeferred: {
    url: string;
    status: string;
    reason?: "agent_budget" | "agent_disabled";
  }[];
}

export function buildSourcesReport(
  options: BuildSourcesOptions,
): SourcesReport {
  const outcomes: SourceOutcome[] = [];
  const triageMap = triageByUrl(options.triageResults);

  for (const page of options.fetchedPages) {
    const url = normalizeUrl(page.final_url || page.url);
    const triage = triageMap.get(url);

    if (page.error) {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "fetch_failed",
        error: page.error,
        triage_status: triage?.status,
        triage_confidence: triage?.confidence,
        source_data_confidence: triage?.source_data_confidence,
        expected_yield: triage?.expected_yield,
      });
      continue;
    }

    if (triage && SKIPPED_STATUSES.has(triage.status)) {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "skipped",
        triage_status: triage.status,
        triage_confidence: triage.confidence,
        source_data_confidence: triage.source_data_confidence,
        expected_yield: triage.expected_yield,
        error: triage.reasoning.slice(0, 200),
      });
    }
  }

  for (const deferred of options.agentDeferred) {
    outcomes.push({
      url: normalizeUrl(deferred.url),
      phase: options.phase,
      outcome: "agent_deferred",
      triage_status: deferred.status,
      error: deferred.reason === "agent_disabled"
        ? "TinyFish Agent disabled for browser/form/detail follow-up"
        : "Exceeded MAX_AGENT_RUNS_PER_PHASE budget",
    });
  }

  for (const run of options.agentRuns) {
    const url = normalizeUrl(run.url);
    if (run.error || run.agent_status === "FAILED" || run.agent_status === "TIMEOUT") {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "agent_failed",
        triage_status: run.status,
        error: run.error ?? run.agent_status,
        records_extracted: run.records_extracted,
      });
    } else if (run.records_extracted === 0) {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "no_records",
        triage_status: run.status,
        records_extracted: 0,
      });
    } else {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "success",
        triage_status: run.status,
        records_extracted: run.records_extracted,
      });
    }
  }

  const outcomeUrls = new Set(outcomes.map((item) => item.url));
  for (const triage of options.triageResults) {
    const url = normalizeUrl(triage.final_url);
    if (outcomeUrls.has(url)) continue;

    if (triage.status === "extract_now") {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "success",
        triage_status: triage.status,
        triage_confidence: triage.confidence,
        source_data_confidence: triage.source_data_confidence,
        expected_yield: triage.expected_yield,
      });
    } else if (statusNeedsAgent(triage.status)) {
      outcomes.push({
        url,
        phase: options.phase,
        outcome: "no_records",
        triage_status: triage.status,
        triage_confidence: triage.confidence,
        source_data_confidence: triage.source_data_confidence,
        expected_yield: triage.expected_yield,
        error: "Agent path did not yield records",
      });
    }
  }

  const byOutcome: Record<string, number> = {};
  for (const item of outcomes) {
    byOutcome[item.outcome] = (byOutcome[item.outcome] ?? 0) + 1;
  }

  const failed = outcomes.filter((item) =>
    ["fetch_failed", "skipped", "agent_failed", "agent_deferred", "no_records"].includes(
      item.outcome,
    ),
  );

  return {
    total: outcomes.length,
    failed,
    by_outcome: byOutcome,
    outcomes,
  };
}

export function mergeSourcesReports(
  initial: SourcesReport,
  repair: SourcesReport | null,
): SourcesReport {
  const outcomes = [...initial.outcomes, ...(repair?.outcomes ?? [])];
  const byOutcome: Record<string, number> = {};
  for (const item of outcomes) {
    byOutcome[item.outcome] = (byOutcome[item.outcome] ?? 0) + 1;
  }
  const failed = outcomes.filter((item) =>
    ["fetch_failed", "skipped", "agent_failed", "agent_deferred", "no_records"].includes(
      item.outcome,
    ),
  );
  return {
    total: outcomes.length,
    failed,
    by_outcome: byOutcome,
    outcomes,
  };
}
