import { z } from "zod";

/** Placeholder for a future quality-driven repair pass (not executed yet). */
export const repairLoopStateSchema = z.object({
  current_loop: z.number().int().nonnegative(),
  max_loops: z.number().int().positive(),
  status: z.enum(["idle", "pending", "running", "completed"]),
  last_started_at: z.string().datetime().optional(),
  last_completed_at: z.string().datetime().optional(),
  notes: z.array(z.string()).default([]),
});

export type RepairLoopState = z.infer<typeof repairLoopStateSchema>;

export const browserAgentProviderSchema = z.enum(["tinyfish", "playwright"]);

export type BrowserAgentProvider = z.infer<typeof browserAgentProviderSchema>;

/** One browser-agent visit (Tinyfish today; Playwright when plugged in). */
export const agentVisitedUrlEntrySchema = z.object({
  url: z.string().url(),
  final_url: z.string().url().optional(),
  repair_loop: z.number().int().nonnegative(),
  provider: browserAgentProviderSchema,
  goal: z.string(),
  run_id: z.string().nullable().optional(),
  status: z.string(),
  visited_at: z.string().datetime(),
  error: z.string().nullable().optional(),
  /** Raw Tinyfish run payload or normalized process steps for Playwright replay. */
  emitted_process: z.record(z.string(), z.unknown()).optional(),
  triage_status: z.string().optional(),
  suggested_action: z.string().optional(),
});

export type AgentVisitedUrlEntry = z.infer<typeof agentVisitedUrlEntrySchema>;

export const populateCollectionMemorySchema = z.object({
  version: z.literal(1),
  dataset_id: z.string().min(1),
  prompt_fingerprint: z.string().min(1),
  user_prompt: z.string(),
  repair_loop: repairLoopStateSchema,
  agent_visited_urls: z.array(agentVisitedUrlEntrySchema),
  updated_at: z.string().datetime(),
});

export type PopulateCollectionMemory = z.infer<typeof populateCollectionMemorySchema>;
