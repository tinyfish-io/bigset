import { z } from "zod";

export const populateColumnSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "boolean", "url", "date"]),
  description: z.optional(z.string()),
});
export type PopulateColumn = z.infer<typeof populateColumnSchema>;

export const datasetContextSchema = z.object({
  datasetId: z.string().min(1),
  datasetName: z.string(),
  description: z.string(),
  columns: z.array(populateColumnSchema).min(1),
});
export type DatasetContext = z.infer<typeof datasetContextSchema>;
