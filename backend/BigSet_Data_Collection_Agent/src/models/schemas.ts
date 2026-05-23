import { z } from "zod";
import { repairDiagnosisSchema } from "../memory/types.js";
import { qualityReportSchema, sourcesReportSchema } from "./quality.js";
import { sourceStatusSchema } from "./source-status.js";

export const columnSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "date"]),
  description: z.string(),
  required: z.boolean(),
});

export const datasetSpecSchema = z.object({
  intent_summary: z.string(),
  target_row_count: z.number().int().positive(),
  row_grain: z.string(),
  columns: z.array(columnSchema).min(1),
  dedupe_keys: z.preprocess(
    (value) => (Array.isArray(value) ? value.slice(0, 1) : value),
    z.array(z.string()).length(1),
  ),
  search_queries: z.array(z.string()).min(1),
  extraction_hints: z.string(),
});

export type ColumnDef = z.infer<typeof columnSchema>;
export type DatasetSpec = z.infer<typeof datasetSpecSchema>;

export const fieldEvidenceSchema = z.object({
  field: z.string(),
  url: z.string(),
  quote: z.string(),
});

export const extractedRecordSchema = z.object({
  row: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  evidence: z.array(fieldEvidenceSchema),
  source_urls: z.array(z.string()),
  /** LLM-estimated confidence that row values are accurate (0–1). */
  extraction_confidence: z.number().min(0).max(1).optional(),
});

export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;
export type ExtractedRecord = z.infer<typeof extractedRecordSchema>;

export const extractionResultSchema = z.object({
  records: z.array(extractedRecordSchema),
  notes: z.string().optional(),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export const sourceCandidateSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  snippet: z.string(),
  site_name: z.string().optional(),
  query: z.string(),
  position: z.number().optional(),
  /** Search API page (0-based) that produced this candidate. */
  search_page: z.number().int().min(0).optional(),
});

export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;

export const fetchedPageSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  text: z.string(),
  error: z.string().optional(),
  /** Outbound links when Fetch API was called with links: true. */
  outbound_links: z.array(z.string()).optional(),
});

export type FetchedPage = z.infer<typeof fetchedPageSchema>;

export const expectedYieldSchema = z.enum(["complete", "partial", "none"]);

export const sourceTriageResultSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  title: z.string(),
  status: sourceStatusSchema,
  /** Confidence in triage classification (routing). */
  confidence: z.number().min(0).max(1),
  /** Expected accuracy/completeness of data if extracted from this page. */
  source_data_confidence: z.number().min(0).max(1),
  /** Likely yield: full rows, partial rows, or none. */
  expected_yield: expectedYieldSchema,
  reasoning: z.string(),
  suggested_action: z.string().optional(),
});

export type SourceTriageResult = z.infer<typeof sourceTriageResultSchema>;

export const agentGoalSchema = z.object({
  goal: z.string(),
  rationale: z.string(),
});

export type AgentGoal = z.infer<typeof agentGoalSchema>;

export const agentRunRecordSchema = z.object({
  url: z.string(),
  status: sourceStatusSchema,
  run_id: z.string().nullable(),
  agent_status: z.string(),
  goal: z.string(),
  records_extracted: z.number(),
  error: z.string().optional(),
});

export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;

export const triageSummarySchema = z.object({
  pages_triaged: z.number(),
  by_status: z.record(z.string(), z.number()),
  extract_now: z.number(),
  agent_candidates: z.number(),
  agent_dispatched: z.number(),
  agent_deferred: z.number(),
  agent_succeeded: z.number(),
  agent_failed: z.number(),
  skipped: z.number(),
  records_from_extract: z.number(),
  records_from_agent: z.number(),
});

export type TriageSummary = z.infer<typeof triageSummarySchema>;

const phaseStatsSchema = z.object({
  search_queries_executed: z.number(),
  search_pages_paginated: z.number().optional(),
  search_results_collected: z.number(),
  unique_urls_selected: z.number(),
  pages_fetched: z.number(),
  pages_failed: z.number(),
  raw_records_extracted: z.number(),
  triage: triageSummarySchema.optional(),
});

export const llmUsageReportSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  call_count: z.number().int().nonnegative(),
});

export const repairLoopReportSchema = z.object({
  loop_index: z.number().int().positive(),
  diagnosis_summary: z.string().optional(),
  repair_queries: z.array(z.string()),
  rationale: z.string().optional(),
  missing_fields: z.array(z.string()),
  records_before: z.number(),
  records_after: z.number(),
  fields_filled: z.record(z.string(), z.number()),
  partial_count_before: z.number().optional(),
  partial_count_after: z.number().optional(),
  stats: phaseStatsSchema,
});

export type RepairLoopReport = z.infer<typeof repairLoopReportSchema>;

export const repairReportSchema = z.object({
  attempted: z.boolean(),
  total_loops: z.number().int().nonnegative(),
  loops: z.array(repairLoopReportSchema),
  skipped_reason: z.string().optional(),
  missing_fields: z.array(z.string()),
  repair_queries: z.array(z.string()),
  rationale: z.string().optional(),
  records_before: z.number(),
  records_after: z.number(),
  fields_filled: z.record(z.string(), z.number()),
  stats: phaseStatsSchema,
  last_diagnosis: repairDiagnosisSchema.optional(),
});

export const runReportSchema = z.object({
  run_id: z.string(),
  /** Set when this run is a recurring refresh of a prior run. */
  refreshed_from_run_id: z.string().optional(),
  refresh_in_place: z.boolean().optional(),
  prompt: z.string(),
  target_rows: z.number(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number(),
  dataset_spec: datasetSpecSchema,
  stats: phaseStatsSchema.extend({
    records_after_merge: z.number(),
    visualization_records: z.number().optional(),
  }),
  initial: phaseStatsSchema.extend({
    search_queries: z.array(z.string()),
    fetched_urls: z.array(z.string()),
    failed_urls: z.array(z.string()),
  }),
  repair: repairReportSchema,
  search_queries: z.array(z.string()),
  fetched_urls: z.array(z.string()),
  failed_urls: z.array(z.string()),
  errors: z.array(z.string()),
  quality: qualityReportSchema.optional(),
  sources: sourcesReportSchema.optional(),
  llm_usage: llmUsageReportSchema.optional(),
});

export type RunReport = z.infer<typeof runReportSchema>;

export type { QualityReport, RecordQuality, SourcesReport, SourceOutcome } from "./quality.js";
