import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { inferSchema } from "../../pipeline/schema-inference.js";
import { datasetSchemaSchema } from "../../pipeline/types.js";

const inferSchemaStep = createStep({
  id: "infer-schema",
  inputSchema: z.object({
    prompt: z.string().min(1),
  }),
  outputSchema: datasetSchemaSchema,
  execute: async ({ inputData }) => {
    const schema = await inferSchema(inputData.prompt);
    return schema;
  },
});

export const inferSchemaWorkflow = createWorkflow({
  id: "infer-schema-workflow",
  inputSchema: z.object({
    prompt: z.string().min(1),
  }),
  outputSchema: datasetSchemaSchema,
})
  .then(inferSchemaStep)
  .commit();
