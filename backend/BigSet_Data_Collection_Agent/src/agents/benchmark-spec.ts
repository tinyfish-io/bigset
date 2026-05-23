import type { ColumnDef, DatasetSpec } from "../models/schemas.js";
import { normalizeSpecColumnOrder } from "./dataset-spec.js";

/** Benchmark harness fields from prompts.json (via env in adapters). */
export interface BenchmarkSpecContext {
  promptId?: string;
  promptQuality?: string;
  persona?: string;
  expectedStress?: string;
  requiredColumns: string[];
}

export function hasBenchmarkRequiredColumns(
  context?: BenchmarkSpecContext,
): context is BenchmarkSpecContext & { requiredColumns: string[] } {
  return Boolean(context?.requiredColumns?.length);
}

/** Parse comma-separated column names (CLI flag or benchmark env). */
export function parseRequiredColumns(value: string): string[] {
  const columns = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (columns.length === 0) {
    throw new Error(
      "Required columns must include at least one non-empty column name.",
    );
  }
  return columns;
}

/**
 * Ensures every benchmark-required column name exists on the spec as required.
 * Types and descriptions come from the dataset-spec LLM when present; otherwise
 * minimal placeholders (no per-column name heuristics).
 */
export function mergeSpecWithBenchmarkRequiredColumns(
  spec: DatasetSpec,
  context: BenchmarkSpecContext,
): DatasetSpec {
  const requiredColumns = context.requiredColumns;
  const columnsByName = new Map(spec.columns.map((column) => [column.name, column]));

  const requiredColumnDefs: ColumnDef[] = requiredColumns.map((name) => {
    const existing = columnsByName.get(name);
    if (existing) {
      return { ...existing, required: true };
    }
    return {
      name,
      type: "string",
      description: name,
      required: true,
    };
  });

  const optionalExtras = spec.columns.filter(
    (column) => !requiredColumns.includes(column.name),
  );

  const columns = [...requiredColumnDefs, ...optionalExtras];
  const columnNames = new Set(columns.map((column) => column.name));

  const isEntityLikeColumn = (name: string): boolean =>
    /(entity|company|organization|business|restaurant|bakery|provider|product|name|title)/i.test(
      name,
    );

  const dedupeKey =
    requiredColumns.find(
      (name) => columnNames.has(name) && isEntityLikeColumn(name),
    ) ??
    spec.dedupe_keys.find((key) => columnNames.has(key)) ??
    requiredColumns.find((name) => columnNames.has(name)) ??
    spec.dedupe_keys[0];

  const extractionHints = [
    spec.extraction_hints,
    `Benchmark required columns (use as exact row keys): ${requiredColumns.join(", ")}.`,
    context.expectedStress
      ? `Benchmark stress note: ${context.expectedStress}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return normalizeSpecColumnOrder({
    ...spec,
    columns,
    dedupe_keys: dedupeKey ? [dedupeKey] : spec.dedupe_keys,
    extraction_hints: extractionHints,
  });
}
