import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
  DEFAULT_OPENROUTER_MODEL_ID,
  requiredOpenRouterApiKey,
} from "../../openrouter-models.js";
import { populateAgentInstructions } from "../../pipeline/populate-prompt.js";
import {
  getRowTool,
  insertRowTool,
  listRowsTool,
  updateRowTool,
  deleteRowTool,
} from "../tools/dataset-tools.js";
import { createFetchPageTool } from "../tools/web-tools.js";

type PopulateAgentOptions = ConstructorParameters<typeof Agent>[0];

const defaultPopulateTools = {
  insert_row: insertRowTool,
  list_rows: listRowsTool,
  get_row: getRowTool,
  update_row: updateRowTool,
  delete_row: deleteRowTool,
  fetch_page: createFetchPageTool(),
};

export function createPopulateAgent(input: {
  model?: PopulateAgentOptions["model"];
  tools?: PopulateAgentOptions["tools"];
} = {}) {
  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Agent",
    instructions: populateAgentInstructions,
    model: input.model ?? defaultPopulateModel(),
    tools: input.tools ?? defaultPopulateTools,
  });
}

export const populateAgent = createPopulateAgent();

function defaultPopulateModel(): PopulateAgentOptions["model"] {
  const openrouter = createOpenRouter({ apiKey: requiredOpenRouterApiKey() });
  return openrouter(DEFAULT_OPENROUTER_MODEL_ID);
}
