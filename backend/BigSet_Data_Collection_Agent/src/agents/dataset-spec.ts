import { completeJson } from "../integrations/openrouter.js";
import type { WorkflowMemory } from "../memory/types.js";
import {
  datasetSpecSchema,
  type ColumnDef,
  type DatasetSpec,
} from "../models/schemas.js";
import {
  hasBenchmarkRequiredColumns,
  mergeSpecWithBenchmarkRequiredColumns,
  type BenchmarkSpecContext,
} from "./benchmark-spec.js";
import { applyPromptSourcePolicyToSpec } from "./source-policy.js";

const DATASET_SPEC_SYSTEM = `You are the Dataset Spec Agent for a web data collection pipeline.

Given a user's data gathering prompt, produce a JSON object that defines:
- what each CSV row represents (row_grain)
- column names, types, and which are required
- dedupe_keys: exactly ONE column name that identifies a unique row (the main entity field, e.g. entity_name or restaurant_name — used as primary key for merge/repair)
- search_queries: diverse web search strings to find sources (use site: operators when helpful)
- extraction_hints: guidance for downstream extraction

Rules:
- columns[].name must be snake_case
- types must be one of: string, number, boolean, date
- Column order: list every required column first (see ordering below), then optional columns. Do not bury required fields after optional metadata.
- Required columns (required: true):
  - The single dedupe_keys field must be required: true.
  - Every column that the user_prompt explicitly or clearly implies they want per row (e.g. "who's hiring" → is_hiring; "still active" → is_active; "funding amount" → funding column) must be required: true.
  - Do NOT mark only the entity name/identifier as required while leaving core intent fields optional — that blocks the repair loop from filling sparse rows.
  - Optional (required: false) only for nice-to-have extras the user did not ask for (e.g. logo_url when they only care about hiring status).
- Required column ordering within columns[]:
  1. the dedupe_keys field first
  2. other required intent fields (what the user asked to collect)
  3. optional fields last
- For type "number", embed the measurement unit in the column name using snake_case
  (e.g. funding_amount_usd(millions), employee_count, market_cap_million_usd, growth_rate_percent).
  Choose units that match the user's intent; describe the unit in columns[].description when helpful.
  Do not use bare numeric names like "amount", "price", or "funding" without a unit, for example, if the
  numeric value is in millions, use "funding_amount_million_usd" instead of "funding_amount_usd".
- search_queries should be specific, varied (5-8 queries), and likely to surface pages with list/table data
- Temporal relevance for search_queries:
  - Use the provided current_date / current_year when a query needs a time anchor (e.g. "2026", "latest", "recent").
  - Do NOT default to past years (e.g. 2024) unless the user_prompt explicitly names that year or date range.
  - If the user says "recent", "current", "latest", or implies up-to-date data, anchor queries to current_year.
  - If the user gives no time constraint, prefer evergreen queries OR current_year only when recency clearly matters for the dataset.
  - If the user specifies a year or date (e.g. "in 2024", "Q1 2023"), use exactly what they asked for.
- target_row_count should reflect the user's implied or stated goal
- Return ONLY JSON, no markdown`;

function currentTimeContext(): { current_date: string; current_year: number } {
  const now = new Date();
  return {
    current_date: now.toISOString().slice(0, 10),
    current_year: now.getFullYear(),
  };
}

/** Ensure exactly one valid dedupe key exists on the spec. */
export function normalizeDedupeKey(spec: DatasetSpec): DatasetSpec {
  const columnNames = new Set(spec.columns.map((column) => column.name));
  let key = spec.dedupe_keys[0];

  if (!key || !columnNames.has(key)) {
    const firstRequired = spec.columns.find((column) => column.required);
    key = firstRequired?.name ?? spec.columns[0]?.name ?? key;
  }

  if (!key) {
    return spec;
  }

  return { ...spec, dedupe_keys: [key] };
}

/** Enforce required-first column order even if the model returns a different order. */
export function normalizeSpecColumnOrder(spec: DatasetSpec): DatasetSpec {
  const byName = new Map(spec.columns.map((col) => [col.name, col]));
  const ordered: ColumnDef[] = [];
  const used = new Set<string>();

  for (const key of spec.dedupe_keys.slice(0, 1)) {
    const col = byName.get(key);
    if (!col || used.has(key)) continue;
    ordered.push({ ...col, required: true });
    used.add(key);
  }

  for (const col of spec.columns) {
    if (used.has(col.name) || !col.required) continue;
    ordered.push(col);
    used.add(col.name);
  }

  for (const col of spec.columns) {
    if (used.has(col.name)) continue;
    ordered.push(col);
    used.add(col.name);
  }

  return { ...spec, columns: ordered };
}

export async function generateDatasetSpec(
  prompt: string,
  targetRows: number,
  priorMemory?: WorkflowMemory | null,
  benchmark?: BenchmarkSpecContext,
): Promise<DatasetSpec> {
  const { current_date, current_year } = currentTimeContext();

  const spec = await completeJson({
    label: "dataset_spec",
    schema: datasetSpecSchema,
    messages: [
      { role: "system", content: DATASET_SPEC_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          user_prompt: prompt,
          target_row_count: targetRows,
          current_date,
          current_year,
          prior_workflow_memory:
            priorMemory && priorMemory.prompt_fingerprint
              ? {
                  query_stats_top: [...priorMemory.query_stats]
                    .filter((q) => q.record_count > 0)
                    .slice(-8),
                  domain_stats_top: [...priorMemory.domain_stats]
                    .filter((d) => d.record_count > 0)
                    .slice(-8),
                  domain_stats_weak: [...priorMemory.domain_stats]
                    .filter(
                      (d) =>
                        d.fetch_failures > 0 ||
                        (d.record_count > 0 && d.avg_completeness < 0.5),
                    )
                    .slice(-6),
                  dedupe_keys: priorMemory.dedupe_keys,
                  strategy_notes: priorMemory.strategy_notes.slice(-5),
                }
              : undefined,
          column_order_note:
            "required columns first: dedupe_keys in order, then other required intent fields, then optional",
          benchmark_context: hasBenchmarkRequiredColumns(benchmark)
            ? {
                prompt_id: benchmark.promptId,
                prompt_quality: benchmark.promptQuality,
                persona: benchmark.persona,
                expected_stress: benchmark.expectedStress,
                required_columns: benchmark.requiredColumns,
                instruction:
                  "When required_columns is present, columns[].name MUST use those exact snake_case names as the core schema (all required: true). You may add optional extra columns only if they do not replace or rename required_columns. Align search_queries and extraction_hints to satisfy the user_prompt and expected_stress.",
              }
            : undefined,
          output_shape: {
            intent_summary: "string",
            target_row_count: "number",
            row_grain: "string",
            columns: [
              {
                name: "string (snake_case)",
                type: "string | number | boolean | date",
                description: "string",
                required:
                  "boolean — true for dedupe_keys and every field the user_prompt asks to collect per row",
              },
            ],
            dedupe_keys: ["string — exactly one primary entity column name"],
            search_queries: ["string"],
            extraction_hints: "string",
          },
        }),
      },
    ],
  });

  let normalized = normalizeDedupeKey(
    normalizeSpecColumnOrder({
      ...spec,
      target_row_count: targetRows,
    }),
  );

  normalized = applyPromptSourcePolicyToSpec(normalized, prompt);

  if (hasBenchmarkRequiredColumns(benchmark)) {
    normalized = mergeSpecWithBenchmarkRequiredColumns(normalized, benchmark);
  }

  return normalized;
}
