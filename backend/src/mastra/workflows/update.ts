import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { datasetContextSchema } from "../../pipeline/populate.js";
import { authContextSchema } from "./populate.js";

export const updateInputSchema = datasetContextSchema.extend({
  authContext: authContextSchema,
});
export type UpdateInput = z.infer<typeof updateInputSchema>;

const updateStep = createStep({
  id: "update-dataset",
  inputSchema: updateInputSchema,
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ inputData }) => {
    console.log(
      `[update-dataset] triggered dataset=${inputData.datasetId} user=${inputData.authContext.authorizedUserId} run=${inputData.authContext.workflowRunId}`,
    );
    return { message: "Update workflow triggered — logic not yet implemented." };
  },
});

export const updateWorkflow = createWorkflow({
  id: "update-workflow",
  inputSchema: updateInputSchema,
  outputSchema: z.object({ message: z.string() }),
})
  .then(updateStep)
  .commit();
