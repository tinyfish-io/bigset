import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { datasetContextSchema } from "../../pipeline/populate.js";
import { convex, internal } from "../../convex.js";
import { populateAgent } from "../agents/populate.js";

const clearRowsStep = createStep({
  id: "clear-rows",
  inputSchema: datasetContextSchema,
  outputSchema: datasetContextSchema,
  execute: async ({ inputData }) => {
    console.log(`[clear-rows] Clearing rows for dataset ${inputData.datasetId}`);
    await convex.mutation(internal.datasetRows.clearByDataset, {
      datasetId: inputData.datasetId,
    });
    console.log(`[clear-rows] Done`);
    return inputData;
  },
});

const buildPromptStep = createStep({
  id: "build-prompt",
  inputSchema: datasetContextSchema,
  outputSchema: z.object({ prompt: z.string() }),
  execute: async ({ inputData }) => {
    const columnNames = inputData.columns.map((c) => c.name);
    const columnsDesc = inputData.columns
      .map(
        (c) =>
          `- "${c.name}" (${c.type})${c.description ? `: ${c.description}` : ""}`,
      )
      .join("\n");

    const prompt = `Dataset ID: ${inputData.datasetId}
Dataset: ${inputData.datasetName}
Description: ${inputData.description}

Columns:
${columnsDesc}

When calling insert_row, the data object keys MUST be exactly these strings (no backticks, no extra quotes):
${JSON.stringify(columnNames)}

Example insert_row call:
insert_row({ datasetId: "${inputData.datasetId}", data: { ${columnNames.map((n) => `"${n}": <value>`).join(", ")} } })

Search the web for real data about this topic. Then call insert_row to fill in 10 rows. Use real data from your search. Fill in any gaps with realistic fake data.`;

    console.log(`[build-prompt] Built prompt for ${inputData.datasetName} (${inputData.columns.length} columns)`);
    return { prompt };
  },
});

const agentStep = createStep(populateAgent, { maxSteps: 80 });

export const populateWorkflow = createWorkflow({
  id: "populate-workflow",
  inputSchema: datasetContextSchema,
  outputSchema: z.object({ text: z.string() }),
})
  .then(clearRowsStep)
  .then(buildPromptStep)
  .then(agentStep)
  .commit();
