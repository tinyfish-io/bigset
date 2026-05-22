import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  insertRowTool,
  listRowsTool,
  getRowTool,
  updateRowTool,
  deleteRowTool,
} from "../tools/dataset-tools.js";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";
import { populateAgentInstructions } from "../../pipeline/populate-prompt.js";

type PopulateAgentOptions = ConstructorParameters<typeof Agent>[0];

const defaultPopulateTools = {
  insert_row: insertRowTool,
  list_rows: listRowsTool,
  get_row: getRowTool,
  update_row: updateRowTool,
  delete_row: deleteRowTool,
  search_web: searchWebTool,
  fetch_page: fetchPageTool,
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
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
  });
  return openrouter("anthropic/claude-sonnet-4-6");
}
