import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { inferSchema } from "../../pipeline/schema-inference.js";
import { datasetSchemaSchema } from "../../pipeline/types.js";

const schemaInferenceModelConfigSchema = z.object({
  schemaInference: z.string().min(1),
});

const inferSchemaInputSchema = z.object({
  prompt: z.string().min(1),
  modelConfig: schemaInferenceModelConfigSchema.optional(),
  authContext: z.object({
    modelConfig: schemaInferenceModelConfigSchema,
  }).optional(),
});

const inferSchemaStep = createStep({
  id: "infer-schema",
  inputSchema: inferSchemaInputSchema,
  outputSchema: datasetSchemaSchema,
  execute: async ({ inputData }) => {
    const modelSlug =
      inputData.modelConfig?.schemaInference ??
      inputData.authContext?.modelConfig.schemaInference;
    const schema = await inferSchema(inputData.prompt, modelSlug);
    return schema;
  },
});

export const inferSchemaWorkflow = createWorkflow({
  id: "infer-schema-workflow",
  inputSchema: inferSchemaInputSchema,
  outputSchema: datasetSchemaSchema,
})
  .then(inferSchemaStep)
  .commit();
