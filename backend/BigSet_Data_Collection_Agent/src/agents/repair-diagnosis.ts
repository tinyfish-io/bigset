import type { CoverageReport } from "../coverage/analyze.js";
import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import { repairDiagnosisSchema, type RepairDiagnosis } from "../memory/types.js";
import type { DatasetSpec } from "../models/schemas.js";
import type { SourcesReport } from "../models/quality.js";

const DIAGNOSIS_SYSTEM = `You are the Repair Diagnosis Agent for a web data collection pipeline.

A repair loop just finished (or is about to start). Analyze workflow memory, coverage gaps, and source outcomes to explain what failed and how the next search/fetch/agent pass should change.

Rules:
- Be specific and actionable — cite domains, query patterns, and triage/agent failures from memory when relevant.
- recommended_search_patterns: concrete query templates or angles (not duplicates of failed_queries).
- domains_to_prioritize: hosts that previously yielded records or match the missing fields.
- domains_to_avoid: hosts that failed fetch, blocked, or returned no usable rows.
- prefer_tinyfish_agent: true when static fetch/extract failed but navigation or forms are likely needed.
- extraction_notes: hints for extract agents (e.g. which columns are still null, evidence issues).
- Return ONLY JSON`;

export async function generateRepairDiagnosis(options: {
  userPrompt: string;
  spec: DatasetSpec;
  coverage: CoverageReport;
  memory: WorkflowMemory;
  sources?: SourcesReport;
  repairLoop: number;
  maxRepairLoops: number;
}): Promise<RepairDiagnosis> {
  const failedOutcomes =
    options.sources?.failed.slice(0, 20).map((item) => ({
      url: item.url,
      outcome: item.outcome,
      error: item.error?.slice(0, 120),
    })) ?? [];

  return completeJson({
    label: `repair_diagnosis:loop${options.repairLoop}`,
    schema: repairDiagnosisSchema,
    messages: [
      { role: "system", content: DIAGNOSIS_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          user_prompt: options.userPrompt,
          repair_loop: options.repairLoop,
          max_repair_loops: options.maxRepairLoops,
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
            required_columns: options.coverage.required_columns,
            field_gaps: options.coverage.field_gaps,
          },
          source_failures_sample: failedOutcomes,
          workflow_memory: memoryContextForAgents(options.memory),
          output_shape: {
            summary: "string",
            likely_causes: ["string"],
            recommended_search_patterns: ["string"],
            domains_to_prioritize: ["string"],
            domains_to_avoid: ["string"],
            prefer_tinyfish_agent: "boolean",
            agent_strategy_notes: "optional string",
            extraction_notes: "optional string",
          },
        }),
      },
    ],
  });
}
