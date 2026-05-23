import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { searchAcquisitionAgentInstructions } from "../../pipeline/populate-acquisition-prompt.js";
import {
  DEFAULT_OPENROUTER_MODEL_ID,
  requiredOpenRouterApiKey,
} from "../../openrouter-models.js";
import { searchWebTool } from "../tools/web-tools.js";

type SearchAcquisitionAgentOptions = ConstructorParameters<typeof Agent>[0];

export function createSearchAcquisitionAgent(input: {
  model?: SearchAcquisitionAgentOptions["model"];
  tools?: SearchAcquisitionAgentOptions["tools"];
} = {}) {
  return new Agent({
    id: "populate-search-acquisition-agent",
    name: "Populate Search Acquisition Agent",
    instructions: searchAcquisitionAgentInstructions,
    model: input.model ?? defaultSearchAcquisitionModel(),
    tools: input.tools ?? { search_web: searchWebTool },
  });
}

export const searchAcquisitionAgent = createSearchAcquisitionAgent();

function defaultSearchAcquisitionModel(): SearchAcquisitionAgentOptions["model"] {
  const openrouter = createOpenRouter({ apiKey: requiredOpenRouterApiKey() });
  return openrouter(DEFAULT_OPENROUTER_MODEL_ID);
}
