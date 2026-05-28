import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { datasetContextSchema, populateColumnSchema } from "../../pipeline/populate.js";
import { convex, internal } from "../../convex.js";
import { buildRefreshAgent } from "../agents/refresh.js";
import { authContextSchema } from "./populate.js";

export const updateInputSchema = datasetContextSchema.extend({
  authContext: authContextSchema,
});
export type UpdateInput = z.infer<typeof updateInputSchema>;

const rowSchema = z.object({
  _id: z.string(),
  data: z.record(z.string(), z.any()),
  sources: z.array(z.string()).optional(),
  rowSummary: z.string().optional(),
  howFound: z.string().optional(),
});

const markAndFetchOutputSchema = updateInputSchema.extend({
  rows: z.array(rowSchema),
});

const markAndFetchStep = createStep({
  id: "mark-and-fetch",
  inputSchema: updateInputSchema,
  outputSchema: markAndFetchOutputSchema,
  execute: async ({ inputData }) => {
    const selective = inputData.rowIds && inputData.rowIds.length > 0;
    console.log(
      `[mark-and-fetch] Marking ${selective ? inputData.rowIds!.length : "all"} rows for dataset ${inputData.datasetId}`,
    );

    const markedCount = await convex.mutation(internal.datasetRows.markForUpdate, {
      datasetId: inputData.datasetId,
      ...(selective ? { rowIds: inputData.rowIds } : {}),
    });

    const rawRows = await convex.query(internal.datasetRows.listInternal, {
      datasetId: inputData.datasetId,
    });

    let rows = (rawRows as Record<string, unknown>[]).map((r) => ({
      _id: String(r._id),
      data: (r.data ?? {}) as Record<string, unknown>,
      sources: r.sources as string[] | undefined,
      rowSummary: r.rowSummary as string | undefined,
      howFound: r.howFound as string | undefined,
    }));

    if (selective) {
      const selectedSet = new Set(inputData.rowIds);
      rows = rows.filter((r) => selectedSet.has(r._id));
    }

    console.log(`[mark-and-fetch] Marked ${markedCount}, processing ${rows.length} rows`);
    return { ...inputData, rows };
  },
});

const refreshOutputSchema = z.object({
  updatedCount: z.number(),
  totalCount: z.number(),
  errors: z.number(),
});

const MAX_CONCURRENT = 5;

async function processWithConcurrency<T>(
  items: T[],
  handler: (item: T) => Promise<void>,
  max: number,
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(max, items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        await handler(items[i]);
      }
    },
  );
  await Promise.allSettled(workers);
}

const refreshRowsStep = createStep({
  id: "refresh-rows",
  inputSchema: markAndFetchOutputSchema,
  outputSchema: refreshOutputSchema,
  execute: async ({ inputData }) => {
    const { datasetId, columns, authContext, rows } = inputData;
    let updatedCount = 0;
    let errors = 0;

    const pkColumns = columns.filter((c) => c.isPrimaryKey);

    async function processRow(row: z.infer<typeof rowSchema>) {
      try {
        const agent = buildRefreshAgent(datasetId, authContext, columns);

        const pkBlock =
          pkColumns.length > 0
            ? pkColumns
                .map((c) => `- ${c.name}: ${row.data[c.name] ?? ""}`)
                .join("\n")
            : "(no primary keys defined)";
        const existingDataBlock = Object.entries(row.data)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n");
        const sourcesBlock =
          row.sources && row.sources.length > 0
            ? `\nSource URLs to check:\n${row.sources.map((s) => `- ${s}`).join("\n")}`
            : "\nNo source URLs recorded — search the web using the primary key values.";

        const prompt = `Refresh this existing row and update it if the data has changed.

Row ID: ${row._id}

Primary keys:
${pkBlock}

Existing data:
${existingDataBlock}
${sourcesBlock}
${row.rowSummary ? `\nPrevious summary: ${row.rowSummary}` : ""}
${row.howFound ? `\nPreviously found via: ${row.howFound}` : ""}`;

        const result = await agent.generate(prompt, { maxSteps: 10 });
        const text = result.text.toLowerCase();
        if (text.includes("updated: true")) {
          updatedCount++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[refresh-rows] Row ${row._id} failed: ${msg}`,
        );
        errors++;
      } finally {
        try {
          await convex.mutation(internal.datasetRows.clearUpdateStatus, {
            id: row._id,
            expectedDatasetId: datasetId,
          });
        } catch (cleanupErr) {
          const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          if (/not found/i.test(cleanupMsg)) {
            return;
          }
          console.error(`[refresh-rows] Failed to clear update status for row ${row._id}: ${cleanupMsg}`);
        }
      }
    }

    console.log(
      `[refresh-rows] Processing ${rows.length} rows (max ${MAX_CONCURRENT} concurrent)`,
    );
    await processWithConcurrency(rows, processRow, MAX_CONCURRENT);
    console.log(
      `[refresh-rows] Done: ${updatedCount} updated, ${errors} errors, ${rows.length - updatedCount - errors} unchanged`,
    );

    return { updatedCount, totalCount: rows.length, errors };
  },
});

export const updateWorkflow = createWorkflow({
  id: "update-workflow",
  inputSchema: updateInputSchema,
  outputSchema: refreshOutputSchema,
})
  .then(markAndFetchStep)
  .then(refreshRowsStep)
  .commit();
