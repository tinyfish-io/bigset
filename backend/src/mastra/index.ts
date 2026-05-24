import { Mastra } from "@mastra/core/mastra";
import { inferSchemaWorkflow } from "./workflows/infer-schema.js";
import { populateWorkflow } from "./workflows/populate.js";
import { updateWorkflow } from "./workflows/update.js";

/**
 * Mastra registry.
 *
 * `populateAgent` is intentionally NOT registered here. The populate agent
 * is built per-workflow-run via `buildPopulateAgent(authorizedDatasetId)`
 * (see agents/populate.ts and the security note in tools/dataset-tools.ts).
 * A module-level singleton would either need a fake/placeholder dataset id
 * — defeating the closure scope — or expose an unscoped agent in Studio
 * that could write to arbitrary datasets. The workflow itself is still
 * registered, so Mastra Studio can inspect it end-to-end.
 */
export const mastra = new Mastra({
  workflows: { inferSchemaWorkflow, populateWorkflow, updateWorkflow },
});
