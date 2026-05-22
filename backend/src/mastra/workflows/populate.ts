import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { datasetContextSchema } from "../../pipeline/populate.js";
import { buildPopulatePrompt } from "../../pipeline/populate-prompt.js";
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
    const prompt = buildPopulatePrompt(inputData);

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
