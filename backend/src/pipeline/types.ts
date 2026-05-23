import { z } from "zod";

export const columnTypeSchema = z.enum([
  "string",
  "url",
  "date",
  "number",
  "boolean",
  "enum",
]);
export type ColumnType = z.infer<typeof columnTypeSchema>;

const snakeCase = /^[a-z][a-z0-9_]*$/;

export const columnDefinitionSchema = z.object({
  name: z.string().regex(snakeCase, "must be snake_case"),
  display_name: z.string().min(1),
  type: columnTypeSchema,
  is_primary_key: z.boolean(),
  is_enumerable: z.boolean(),
  description: z.string().min(1),
  nullable: z.boolean(),
});
export type ColumnDefinition = z.infer<typeof columnDefinitionSchema>;

export const datasetSchemaSchema = z
  .object({
    dataset_name: z.string().regex(snakeCase, "must be snake_case"),
    description: z.string().min(1),
    columns: z.array(columnDefinitionSchema).min(1),
    primary_key: z.string(),
    search_queries: z.array(z.string().min(1)).min(1),
  })
  .superRefine((data, ctx) => {
    const names = data.columns.map((c) => c.name);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate column names: ${dupes.join(", ")}`,
        path: ["columns"],
      });
    }

    const pkCols = data.columns.filter((c) => c.is_primary_key);
    if (pkCols.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `exactly one column must have is_primary_key=true (found ${pkCols.length})`,
        path: ["columns"],
      });
      return;
    }

    const pk = pkCols[0];
    if (pk.name !== data.primary_key) {
      ctx.addIssue({
        code: "custom",
        message: `primary_key '${data.primary_key}' does not match the column flagged is_primary_key ('${pk.name}')`,
        path: ["primary_key"],
      });
    }
    if (pk.nullable) {
      ctx.addIssue({
        code: "custom",
        message: "primary key column must not be nullable",
        path: ["columns"],
      });
    }
    if (!pk.is_enumerable) {
      ctx.addIssue({
        code: "custom",
        message: "primary key column must have is_enumerable=true",
        path: ["columns"],
      });
    }
  });
export type DatasetSchema = z.infer<typeof datasetSchemaSchema>;

export const datasetRowValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type DatasetRowValue = z.infer<typeof datasetRowValueSchema>;

export const datasetRowSchema = z.record(z.string(), datasetRowValueSchema);
export type DatasetRow = z.infer<typeof datasetRowSchema>;

export const endpointCallSchema = z.object({
  endpoint: z.enum(["search", "fetch", "browser"]),
  count: z.number().int().nonnegative(),
});
export type EndpointCall = z.infer<typeof endpointCallSchema>;

export const runManifestSchema = z.object({
  run_id: z.string(),
  prompt: z.string(),
  schema_path: z.string(),
  dataset_path: z.string(),
  csv_path: z.string(),
  row_count: z.number().int().nonnegative(),
  columns_filled: z.array(z.string()),
  created_at: z.string(),
  endpoints_called: z.array(endpointCallSchema),
});
export type RunManifest = z.infer<typeof runManifestSchema>;

/** Per-URL score returned by the search acquisition agent. */
export const searchAcquisitionScoredUrlSchema = z.object({
  url: z.string().min(1),
  expectation_score: z.number().int().min(1).max(5),
});
export type AgentSearchScore = z.infer<typeof searchAcquisitionScoredUrlSchema>;

/** Structured completion from the search acquisition agent. */
export const searchAcquisitionCompletionSchema = z.object({
  scored_urls: z.array(searchAcquisitionScoredUrlSchema),
  validation_issues: z.array(z.string()).default([]),
});
export type SearchAcquisitionCompletion = z.infer<
  typeof searchAcquisitionCompletionSchema
>;

/** Scored URL after acquisition + prioritization (includes search_query). */
export const acquisitionScoredUrlSchema = z.object({
  url: z.string(),
  expectation_score: z.number().int().min(1).max(5),
  search_query: z.string(),
});
export type AcquisitionScoredUrl = z.infer<typeof acquisitionScoredUrlSchema>;

export const populateAcquisitionResultSchema = z.object({
  prioritizedUrls: z.array(z.string()),
  scoredUrls: z.array(acquisitionScoredUrlSchema),
  initialQueries: z.array(z.string()),
  validationIssues: z.array(z.string()),
});
export type PopulateAcquisitionResult = z.infer<
  typeof populateAcquisitionResultSchema
>;

export const structuredPopulateEvidenceSchema = z.object({
  columnName: z.string().optional(),
  sourceUrl: z.string().optional(),
  quote: z.string(),
});

export const structuredPopulateOutputSchema = z.object({
  rows: z
    .array(
      z.object({
        cells: z.record(z.string(), z.any()),
        sourceUrls: z.array(z.string()).optional(),
        evidence: z.array(structuredPopulateEvidenceSchema).optional(),
        needsReview: z.boolean().optional(),
      })
    )
    .default([]),
  validationIssues: z.array(z.string()).default([]),
});
export type StructuredPopulateOutput = z.infer<
  typeof structuredPopulateOutputSchema
>;

export const populateSourceStatusSchema = z.enum([
  "extract_now",
  "requires_navigation",
  "requires_form_submission",
  "requires_detail_page_followup",
  "irrelevant",
  "duplicate",
  "blocked",
  "low_value",
]);
export type PopulateSourceStatus = z.infer<typeof populateSourceStatusSchema>;

export const populateExpectedYieldSchema = z.enum([
  "complete",
  "partial",
  "none",
]);
export type PopulateExpectedYield = z.infer<typeof populateExpectedYieldSchema>;

export const populateSourceTriageResultSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  title: z.string(),
  status: populateSourceStatusSchema,
  confidence: z.number().min(0).max(1),
  source_data_confidence: z.number().min(0).max(1),
  expected_yield: populateExpectedYieldSchema,
  reasoning: z.string(),
  suggested_action: z.string().optional(),
});
export type PopulateSourceTriageResult = z.infer<
  typeof populateSourceTriageResultSchema
>;

const populateLlmEvidenceSchema = z.object({
  field: z.string(),
  quote: z.string(),
  url: z.string().optional(),
});

export function buildPopulateLlmExtractionSchema(columnNames: string[]) {
  const rowShape: Record<string, z.ZodTypeAny> = {};
  for (const name of columnNames) {
    rowShape[name] = z.union([z.string(), z.number(), z.boolean(), z.null()]);
  }
  return z.object({
    records: z.array(
      z.object({
        row: z.object(rowShape),
        evidence: z.array(populateLlmEvidenceSchema).default([]),
        extraction_confidence: z.number().min(0).max(1).optional(),
      })
    ),
    notes: z.string().optional(),
  });
}

export function buildPopulateTriageExtractSchema(columnNames: string[]) {
  return z.object({
    triage_results: populateSourceTriageResultSchema,
    extraction_results: buildPopulateLlmExtractionSchema(columnNames),
  });
}
