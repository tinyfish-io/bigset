import { z } from "zod";

const FREE_TIER_MONTHLY_QUOTA = 2500;

export const populateColumnSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "boolean", "url", "date"]),
  description: z.optional(z.string()),
  isPrimaryKey: z.optional(z.boolean()),
  nullable: z.optional(z.boolean()),
  validationRegex: z.optional(z.string()),
  normalizationHint: z.optional(z.string()),
});
export type PopulateColumn = z.infer<typeof populateColumnSchema>;

export const datasetContextSchema = z.object({
  datasetId: z.string().min(1),
  datasetName: z.string(),
  description: z.string(),
  maxRowCount: z.number().int().min(1).max(FREE_TIER_MONTHLY_QUOTA).default(100),
  columns: z.array(populateColumnSchema).min(1),
  rowIds: z.array(z.string()).min(1).optional(),
  retrievalStrategy: z.enum(["search_fetch", "browser", "hybrid"]).optional(),
  sourceHint: z.string().optional(),
});
export type DatasetContext = z.infer<typeof datasetContextSchema>;
