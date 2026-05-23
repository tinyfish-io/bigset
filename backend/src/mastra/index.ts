import { Mastra } from "@mastra/core/mastra";
import { inferSchemaWorkflow } from "./workflows/infer-schema.js";
import { populateWorkflow } from "./workflows/populate.js";
import { populateAgent } from "./agents/populate.js";
import { searchAcquisitionAgent } from "./agents/search-acquisition.js";

export const mastra = new Mastra({
  agents: { populateAgent, searchAcquisitionAgent },
  workflows: { inferSchemaWorkflow, populateWorkflow },
});
