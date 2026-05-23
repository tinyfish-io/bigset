import type { CoverageReport } from "../coverage/analyze.js";
import type {
  AgentRunRecord,
  DatasetSpec,
  ExtractedRecord,
  SourceCandidate,
  SourceTriageResult,
} from "../models/schemas.js";
import { promptFingerprint } from "./fingerprint.js";
import { effectiveWeightedQuality } from "./search-pagination.js";
import {
  attributeRecordsToMemory,
  mergeAgentGoalEntry,
  mergeDomainEntry,
  mergeQueryEntry,
} from "./scored-aggregates.js";
import type {
  RepairDiagnosis,
  WorkflowMemory,
} from "./types.js";

export function createWorkflowMemory(
  userPrompt: string,
  spec?: DatasetSpec,
): WorkflowMemory {
  return {
    prompt_fingerprint: promptFingerprint(userPrompt),
    user_prompt: userPrompt,
    repair_loop_count: 0,
    query_stats: [],
    domain_stats: [],
    agent_goal_stats: [],
    dedupe_keys: spec?.dedupe_keys ?? [],
    extraction_schema: spec ? snapshotExtractionSchema(spec) : undefined,
    diagnoses: [],
    strategy_notes: [],
  };
}

export function snapshotExtractionSchema(
  spec: DatasetSpec,
): WorkflowMemory["extraction_schema"] {
  return {
    row_grain: spec.row_grain,
    dedupe_keys: spec.dedupe_keys,
    columns: spec.columns.map((col) => ({
      name: col.name,
      type: col.type,
      required: col.required,
    })),
  };
}

export function recordPhaseInMemory(options: {
  memory: WorkflowMemory;
  spec: DatasetSpec;
  phase: string;
  repairLoop: number;
  queries: string[];
  candidates: SourceCandidate[];
  records: ExtractedRecord[];
  failedUrls: string[];
  agentRuns: AgentRunRecord[];
  triageResults: SourceTriageResult[];
}): void {
  attributeRecordsToMemory(options);
}

export function recordDiagnosis(
  memory: WorkflowMemory,
  repairLoop: number,
  diagnosis: RepairDiagnosis,
): void {
  memory.diagnoses.push({ repair_loop: repairLoop, diagnosis });
  if (diagnosis.summary) {
    memory.strategy_notes.push(`[loop ${repairLoop}] ${diagnosis.summary}`);
  }
  if (memory.strategy_notes.length > 30) {
    memory.strategy_notes.splice(0, memory.strategy_notes.length - 30);
  }
}

export function recordCoverageGaps(
  memory: WorkflowMemory,
  coverage: CoverageReport,
): void {
  memory.last_missing_fields = coverage.field_gaps.map((gap) => gap.column);
}

export function mergePersistentMemory(
  base: WorkflowMemory,
  prior: WorkflowMemory | null,
): WorkflowMemory {
  if (!prior || prior.prompt_fingerprint !== base.prompt_fingerprint) {
    return base;
  }

  for (const source of prior.query_stats) {
    const target = base.query_stats.find(
      (item) => item.query === source.query && item.phase === source.phase,
    );
    if (target) mergeQueryEntry(target, source);
    else base.query_stats.push({ ...source });
  }

  for (const source of prior.domain_stats) {
    const target = base.domain_stats.find((item) => item.domain === source.domain);
    if (target) mergeDomainEntry(target, source);
    else base.domain_stats.push({ ...source });
  }

  for (const source of prior.agent_goal_stats) {
    const target = base.agent_goal_stats.find(
      (item) => item.url === source.url && item.goal === source.goal,
    );
    if (target) mergeAgentGoalEntry(target, source);
    else base.agent_goal_stats.push({ ...source });
  }

  for (const note of prior.strategy_notes) {
    if (!base.strategy_notes.includes(note)) {
      base.strategy_notes.push(note);
    }
  }

  return base;
}

function topQueries(memory: WorkflowMemory, limit: number) {
  return [...memory.query_stats]
    .filter((item) => item.record_count > 0)
    .sort(
      (a, b) => effectiveWeightedQuality(b) - effectiveWeightedQuality(a),
    )
    .slice(0, limit);
}

function weakQueries(memory: WorkflowMemory, limit: number) {
  return [...memory.query_stats]
    .filter((item) => item.urls_produced > 0 && item.record_count === 0)
    .slice(-limit);
}

function topDomains(memory: WorkflowMemory, limit: number) {
  return [...memory.domain_stats]
    .filter((item) => item.record_count > 0)
    .sort(
      (a, b) =>
        b.avg_completeness + b.avg_confidence - (a.avg_completeness + a.avg_confidence),
    )
    .slice(-limit);
}

function weakDomains(memory: WorkflowMemory, limit: number) {
  return [...memory.domain_stats]
    .filter(
      (item) =>
        item.fetch_failures > 0 ||
        (item.record_count > 0 && item.avg_completeness < 0.5),
    )
    .sort((a, b) => b.fetch_failures - a.fetch_failures)
    .slice(-limit);
}

function topAgentGoals(memory: WorkflowMemory, limit: number) {
  return [...memory.agent_goal_stats]
    .filter((item) => item.record_count > 0)
    .sort(
      (a, b) =>
        b.avg_completeness + b.avg_confidence - (a.avg_completeness + a.avg_confidence),
    )
    .slice(-limit);
}

/** Compact context injected into LLM agent calls. */
export function memoryContextForAgents(memory: WorkflowMemory): Record<string, unknown> {
  return {
    repair_loop_count: memory.repair_loop_count,
    query_stats_top: topQueries(memory, 12),
    query_stats_weak: weakQueries(memory, 10),
    domain_stats_top: topDomains(memory, 15),
    domain_stats_weak: weakDomains(memory, 12),
    agent_goal_stats_top: topAgentGoals(memory, 6),
    extraction_schema: memory.extraction_schema,
    dedupe_keys: memory.dedupe_keys,
    last_missing_fields: memory.last_missing_fields,
    strategy_notes: memory.strategy_notes.slice(-8),
    latest_diagnosis:
      memory.diagnoses.length > 0
        ? memory.diagnoses[memory.diagnoses.length - 1]!.diagnosis
        : undefined,
  };
}

export function domainMemoryBoost(
  memory: WorkflowMemory,
  domain: string,
): number {
  const stats = memory.domain_stats.find((item) => item.domain === domain);
  if (!stats) return 0;

  if (stats.record_count === 0 && stats.fetch_failures > 0) {
    return -4;
  }

  const qualityScore = (stats.avg_completeness + stats.avg_confidence) / 2;
  return (qualityScore - 0.5) * 4;
}
