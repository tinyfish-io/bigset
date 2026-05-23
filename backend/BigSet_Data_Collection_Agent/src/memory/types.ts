import { z } from "zod";

export const queryPageBreakdownSchema = z.object({
  page: z.number().int().min(0),
  urls_produced: z.number().int().nonnegative(),
  urls_with_records: z.number().int().nonnegative(),
  record_count: z.number().int().nonnegative(),
  avg_completeness: z.number().min(0).max(1),
  avg_confidence: z.number().min(0).max(1),
});

export type QueryPageBreakdown = z.infer<typeof queryPageBreakdownSchema>;

/** Rolling aggregate for a search query based on records from URLs it surfaced. */
export const queryMemoryEntrySchema = z.object({
  query: z.string(),
  phase: z.string(),
  repair_loop: z.number(),
  urls_produced: z.number().int().nonnegative(),
  urls_with_records: z.number().int().nonnegative(),
  record_count: z.number().int().nonnegative(),
  avg_completeness: z.number().min(0).max(1),
  avg_confidence: z.number().min(0).max(1),
  /** Last Search API page index used for this query (0-based). */
  search_page: z.number().int().min(0).default(0),
  /** Page-weighted quality for recurring search (earlier pages weigh more). */
  weighted_quality: z.number().min(0).max(1).default(0),
  page_breakdown: z.array(queryPageBreakdownSchema).default([]),
});

export type QueryMemoryEntry = z.infer<typeof queryMemoryEntrySchema>;

/** Rolling aggregate for a hostname from records attributed to that domain. */
export const domainMemoryEntrySchema = z.object({
  domain: z.string(),
  record_count: z.number().int().nonnegative(),
  fetch_failures: z.number().int().nonnegative(),
  avg_completeness: z.number().min(0).max(1),
  avg_confidence: z.number().min(0).max(1),
  last_repair_loop: z.number().int().nonnegative(),
});

export type DomainMemoryEntry = z.infer<typeof domainMemoryEntrySchema>;

/** Rolling aggregate for a Tinyfish Agent goal from records on that URL. */
export const agentGoalMemoryEntrySchema = z.object({
  url: z.string(),
  goal: z.string(),
  repair_loop: z.number(),
  record_count: z.number().int().nonnegative(),
  avg_completeness: z.number().min(0).max(1),
  avg_confidence: z.number().min(0).max(1),
});

export type AgentGoalMemoryEntry = z.infer<typeof agentGoalMemoryEntrySchema>;

export const extractionSchemaSnapshotSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
    }),
  ),
  dedupe_keys: z.array(z.string()),
  row_grain: z.string(),
});

export const repairDiagnosisSchema = z.object({
  summary: z.string(),
  likely_causes: z.array(z.string()),
  recommended_search_patterns: z.array(z.string()),
  domains_to_prioritize: z.array(z.string()),
  domains_to_avoid: z.array(z.string()),
  prefer_tinyfish_agent: z.boolean(),
  agent_strategy_notes: z.string().optional(),
  extraction_notes: z.string().optional(),
});

export type RepairDiagnosis = z.infer<typeof repairDiagnosisSchema>;

export const workflowMemorySchema = z.object({
  prompt_fingerprint: z.string(),
  user_prompt: z.string(),
  repair_loop_count: z.number(),
  query_stats: z.array(queryMemoryEntrySchema),
  domain_stats: z.array(domainMemoryEntrySchema),
  agent_goal_stats: z.array(agentGoalMemoryEntrySchema),
  extraction_schema: extractionSchemaSnapshotSchema.optional(),
  dedupe_keys: z.array(z.string()),
  diagnoses: z.array(
    z.object({
      repair_loop: z.number(),
      diagnosis: repairDiagnosisSchema,
    }),
  ),
  strategy_notes: z.array(z.string()),
  last_missing_fields: z.array(z.string()).optional(),
});

export type WorkflowMemory = z.infer<typeof workflowMemorySchema>;
