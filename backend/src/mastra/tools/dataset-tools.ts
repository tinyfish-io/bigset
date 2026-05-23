import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { convex, api, internal } from "../../convex.js";

const resultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

function cleanDataKeys(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    cleaned[key.replace(/^["`]+|["`]+$/g, "")] = value;
  }
  return cleaned;
}

export const insertRowTool = createTool({
  id: "insert_row",
  description:
    "Insert a single row into the dataset. Call this each time you have a row ready — don't wait to batch them.",
  inputSchema: z.object({
    datasetId: z.string(),
    data: z.record(z.string(), z.any()),
  }),
  outputSchema: resultSchema,
  execute: async ({ datasetId, data }) => {
    if (!datasetId) return { success: false, error: "datasetId is required." };
    if (!data || Object.keys(data).length === 0)
      return { success: false, error: "data is required and must have at least one key. Pass an object like { \"Column Name\": value }." };

    const cleanedData = cleanDataKeys(data);
    console.log(`[insert_row] Inserting row into ${datasetId} (${Object.keys(cleanedData).length} columns)`);
    try {
      await convex.mutation(internal.datasetRows.insert, { datasetId, data: cleanedData });
      console.log(`[insert_row] Row inserted successfully`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[insert_row] Failed:`, msg);
      if (msg.includes("not found"))
        return { success: false, error: `Dataset "${datasetId}" not found. Check the datasetId is correct.` };
      if (msg.includes("validator"))
        return { success: false, error: `Data validation failed: ${msg}. Check that your data keys are plain strings and values match expected types.` };
      return { success: false, error: `Insert failed: ${msg}` };
    }
  },
});

export const listRowsTool = createTool({
  id: "list_rows",
  description:
    "Read all rows in the dataset. Returns an array of row objects, each with _id and data fields.",
  inputSchema: z.object({
    datasetId: z.string(),
  }),
  outputSchema: z.object({ rows: z.array(z.any()).optional(), error: z.string().optional() }),
  execute: async ({ datasetId }) => {
    if (!datasetId) return { error: "datasetId is required." };

    console.log(`[list_rows] Reading all rows for dataset ${datasetId}`);
    try {
      const rows = await convex.query(api.datasetRows.listByDataset, { datasetId });
      console.log(`[list_rows] Found ${rows.length} rows`);
      return { rows };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[list_rows] Failed:`, msg);
      if (msg.includes("not found"))
        return { error: `Dataset "${datasetId}" not found. Check the datasetId.` };
      return { error: `List rows failed: ${msg}` };
    }
  },
});

export const getRowTool = createTool({
  id: "get_row",
  description:
    "Read a single row by its ID. Returns the row object with _id and data fields, or an error if not found.",
  inputSchema: z.object({
    rowId: z.string(),
  }),
  outputSchema: z.object({ row: z.any().optional(), error: z.string().optional() }),
  execute: async ({ rowId }) => {
    if (!rowId) return { error: "rowId is required." };

    console.log(`[get_row] Reading row ${rowId}`);
    try {
      const row = await convex.query(internal.datasetRows.get, { id: rowId });
      if (!row) return { error: `Row "${rowId}" not found. It may have been deleted.` };
      console.log(`[get_row] Found`);
      return { row };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[get_row] Failed:`, msg);
      if (msg.includes("validator") || msg.includes("Invalid"))
        return { error: `Invalid row ID format: "${rowId}". Row IDs look like "jd7..." — they are Convex document IDs.` };
      return { error: `Get row failed: ${msg}` };
    }
  },
});

export const updateRowTool = createTool({
  id: "update_row",
  description:
    "Update an existing row by its ID. Pass the full updated data object. Changes are tracked in history.",
  inputSchema: z.object({
    rowId: z.string(),
    data: z.record(z.string(), z.any()),
  }),
  outputSchema: resultSchema,
  execute: async ({ rowId, data }) => {
    if (!rowId) return { success: false, error: "rowId is required." };
    if (!data || Object.keys(data).length === 0)
      return { success: false, error: "data is required. Pass the full updated row data object." };

    const cleanedData = cleanDataKeys(data);
    console.log(`[update_row] Updating row ${rowId} (${Object.keys(cleanedData).length} columns)`);
    try {
      await convex.mutation(internal.datasetRows.update, { id: rowId, data: cleanedData });
      console.log(`[update_row] Row updated successfully`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[update_row] Failed:`, msg);
      if (msg.includes("Row not found") || msg.includes("not found"))
        return { success: false, error: `Row "${rowId}" not found. Use list_rows to see existing row IDs.` };
      if (msg.includes("validator") || msg.includes("Invalid"))
        return { success: false, error: `Invalid input: ${msg}. Check that rowId is a valid Convex ID and data keys are plain strings.` };
      return { success: false, error: `Update failed: ${msg}` };
    }
  },
});

export const deleteRowTool = createTool({
  id: "delete_row",
  description:
    "Delete a single row by its ID. This is permanent.",
  inputSchema: z.object({
    rowId: z.string(),
  }),
  outputSchema: resultSchema,
  execute: async ({ rowId }) => {
    if (!rowId) return { success: false, error: "rowId is required." };

    console.log(`[delete_row] Deleting row ${rowId}`);
    try {
      await convex.mutation(internal.datasetRows.remove, { id: rowId });
      console.log(`[delete_row] Row deleted successfully`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[delete_row] Failed:`, msg);
      if (msg.includes("not found"))
        return { success: false, error: `Row "${rowId}" not found. It may have already been deleted.` };
      if (msg.includes("validator") || msg.includes("Invalid"))
        return { success: false, error: `Invalid row ID format: "${rowId}". Use list_rows to find valid row IDs.` };
      return { success: false, error: `Delete failed: ${msg}` };
    }
  },
});
