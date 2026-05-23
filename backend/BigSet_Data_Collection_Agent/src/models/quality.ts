import { z } from "zod";

export const recordStatusSchema = z.enum([
  "complete",
  "partial",
  "low_confidence",
]);

export type RecordStatus = z.infer<typeof recordStatusSchema>;

export const recordQualitySchema = z.object({
  record_id: z.string(),
  record_status: recordStatusSchema,
  needs_review: z.boolean(),
  completeness_pct: z.number().min(0).max(1),
  /** Mean confidence across required fields (from per-field source signals). */
  confidence_score: z.number().min(0).max(1),
  field_confidences: z.record(z.string(), z.number().min(0).max(1)).default({}),
  missing_required_fields: z.array(z.string()),
  missing_optional_fields: z.array(z.string()),
  fields_without_evidence: z.array(z.string()),
  review_reasons: z.array(z.string()),
});

export type RecordQuality = z.infer<typeof recordQualitySchema>;

export const qualityBucketSchema = z.object({
  count: z.number().int().nonnegative(),
  record_ids: z.array(z.string()),
});

export type QualityBucket = z.infer<typeof qualityBucketSchema>;

export const qualityReportSchema = z.object({
  total_records: z.number().int().nonnegative(),
  unkeyed_records: z.number().int().nonnegative(),
  complete: qualityBucketSchema,
  partial: qualityBucketSchema,
  low_confidence: qualityBucketSchema,
  needs_review: qualityBucketSchema,
  records: z.array(recordQualitySchema),
});

export type QualityReport = z.infer<typeof qualityReportSchema>;

export const sourceOutcomeTypeSchema = z.enum([
  "success",
  "fetch_failed",
  "skipped",
  "extract_failed",
  "agent_failed",
  "agent_deferred",
  "no_records",
]);

export type SourceOutcomeType = z.infer<typeof sourceOutcomeTypeSchema>;

export const sourceOutcomeSchema = z.object({
  url: z.string(),
  phase: z.enum(["initial", "repair"]),
  outcome: sourceOutcomeTypeSchema,
  triage_status: z.string().optional(),
  triage_confidence: z.number().optional(),
  source_data_confidence: z.number().optional(),
  expected_yield: z.string().optional(),
  error: z.string().optional(),
  records_extracted: z.number().optional(),
});

export type SourceOutcome = z.infer<typeof sourceOutcomeSchema>;

export const sourcesReportSchema = z.object({
  total: z.number().int().nonnegative(),
  failed: z.array(sourceOutcomeSchema),
  by_outcome: z.record(z.string(), z.number()),
  outcomes: z.array(sourceOutcomeSchema),
});

export type SourcesReport = z.infer<typeof sourcesReportSchema>;
