import { z } from "zod";
import type { CoverageReport } from "../coverage/analyze.js";
import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import type { RepairDiagnosis } from "../memory/types.js";
import type { DatasetSpec } from "../models/schemas.js";

const repairQueriesSchema = z.object({
  repair_queries: z.array(z.string()).min(1),
  rationale: z.string(),
});

export type RepairQueriesResult = z.infer<typeof repairQueriesSchema>;

function buildRepairQueriesSystem(maxQueries: number): string {
  const minQueries = Math.min(2, maxQueries);
  return `You are the Coverage & Query Planning Agent for a web data collection pipeline.

After an initial extraction pass, some required fields are still missing. Generate targeted web search queries to find pages that can fill those gaps.

Rules:
- Return between ${minQueries} and ${maxQueries} repair_queries (the user message includes max_queries — use as many distinct queries as needed, up to that limit).
- Prefer more queries when multiple fields or example rows need coverage (e.g. one query angle per missing field or per entity in example_rows).
- Each query should aim at a different source angle (company site, press release, database, registry, news).
- Include entity names or attributes from example_rows when available.
- Do NOT repeat or lightly rephrase queries already in prior_search_queries.
- Temporal rules (same as initial search):
  - Use current_year / current_date when recency matters unless the user_prompt names a specific year.
  - Do not default to outdated years.
- Prefer queries likely to return factual detail pages, not generic listicles.
- Use workflow_memory.query_stats_weak (low completeness/confidence) to avoid repeating bad queries; prefer angles similar to query_stats_top.
- Use workflow_memory.domain_stats_top / domain_stats_weak when choosing site: operators or domains to target.
- Follow recommended_search_patterns from latest_diagnosis when present.
- Return ONLY JSON`;
}

function currentTimeContext(): { current_date: string; current_year: number } {
  const now = new Date();
  return {
    current_date: now.toISOString().slice(0, 10),
    current_year: now.getFullYear(),
  };
}

export async function generateRepairQueries(options: {
  userPrompt: string;
  spec: DatasetSpec;
  coverage: CoverageReport;
  priorSearchQueries: string[];
  maxQueries: number;
  memory?: WorkflowMemory;
  diagnosis?: RepairDiagnosis;
  repairLoop?: number;
}): Promise<RepairQueriesResult> {
  const { current_date, current_year } = currentTimeContext();

  const result = await completeJson({
    label: "repair_queries",
    schema: repairQueriesSchema,
    messages: [
      {
        role: "system",
        content: buildRepairQueriesSystem(options.maxQueries),
      },
      {
        role: "user",
        content: JSON.stringify({
          user_prompt: options.userPrompt,
          current_date,
          current_year,
          max_queries: options.maxQueries,
          instruction: `Generate up to ${options.maxQueries} distinct repair_queries. Use as many as needed to cover missing fields and example rows; do not stop at 5 unless you have fewer useful angles.`,
          dataset_spec: {
            intent_summary: options.spec.intent_summary,
            row_grain: options.spec.row_grain,
            columns: options.spec.columns,
            dedupe_keys: options.spec.dedupe_keys,
          },
          coverage: {
            total_records: options.coverage.total_records,
            complete_count: options.coverage.complete_count,
            partial_count: options.coverage.partial_count,
            partial_record_ids: options.coverage.partial_record_ids,
            field_gaps: options.coverage.field_gaps,
          },
          prior_search_queries: options.priorSearchQueries,
          repair_loop: options.repairLoop ?? options.memory?.repair_loop_count ?? 0,
          repair_diagnosis: options.diagnosis,
          workflow_memory: options.memory
            ? memoryContextForAgents(options.memory)
            : undefined,
          output_shape: {
            repair_queries: ["string"],
            rationale: "string",
          },
        }),
      },
    ],
  });

  return {
    ...result,
    repair_queries: result.repair_queries.slice(0, options.maxQueries),
  };
}
