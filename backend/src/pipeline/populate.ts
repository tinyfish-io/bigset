import { z } from "zod";

export const populateColumnSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "boolean", "url", "date"]),
  description: z.optional(z.string()),
  isPrimaryKey: z.optional(z.boolean()),
});
export type PopulateColumn = z.infer<typeof populateColumnSchema>;

export const datasetContextSchema = z.object({
  datasetId: z.string().min(1),
  datasetName: z.string(),
  description: z.string(),
  columns: z.array(populateColumnSchema).min(1),
  rowIds: z.array(z.string()).min(1).optional(),
});
export type DatasetContext = z.infer<typeof datasetContextSchema>;
