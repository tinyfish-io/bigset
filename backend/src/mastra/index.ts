import { Mastra } from "@mastra/core/mastra";
import { inferSchemaWorkflow } from "./workflows/infer-schema.js";

export const mastra = new Mastra({
  workflows: { inferSchemaWorkflow },
});
