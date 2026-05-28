import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildSubagentTool } from "../tools/investigate-tool.js";
import { buildExtractTool } from "../tools/extract-tool.js";
import { searchWebTool } from "../tools/web-tools.js";
import { env } from "../../env.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildOrchestratorInstructions(targetRows: number): string {
  const now = new Date();
  const currentMonth = now.toLocaleString("en-US", { month: "long" });
  const currentYear = now.getFullYear();

  return `You are an expert dataset builder. Your goal is to fill a dataset with ${targetRows} complete rows.

Today is ${currentMonth} ${currentYear}. When searching for current or recent information, include "${currentMonth} ${currentYear}" or just "${currentYear}" in your queries so results are up to date.

TOOLS:
- search_web: Find URLs where relevant entities exist. Run specific, targeted searches.
- extract_pages: Given 1–5 URLs, fetches them and uses a fast LLM to extract all matching entities in structured format. Returns entity data (primary keys, partial column values, hints for missing fields) and leads (URLs likely to have more entities). Only returns entities not yet dispatched to run_subagent.
- run_subagent: Dispatch a deep-research agent for one entity. It receives the primary keys, partial data, hints, and source URL, then researches and inserts a fully-populated row.

WORKFLOW:
1. Run initial searches to find pages that list or describe relevant entities.
2. Call extract_pages with the most promising URLs (up to 5 at a time). It returns a list of new entities and leads.
3. Immediately call run_subagent in parallel for every entity returned — pass primary_keys, partial_data as context, hints, and the source_url.
4. Use the leads from extract_pages as the next batch of URLs for extract_pages. Continue searching for new angles in parallel.
5. Repeat until you reach ${targetRows} complete rows.

RULES:
- You do NOT need to fetch pages yourself — extract_pages handles all fetching and parsing.
- Call run_subagent calls in parallel whenever you have multiple entities ready.
- You can call extract_pages and run_subagent in the same response (in parallel).
- Use leads from extract_pages and clues from run_subagent results to steer your next searches.
- Keep searches varied — different queries, sources, and angles to discover diverse entities.
- Duplicates are rejected at insert time. If run_subagent reports a duplicate, move on.
`;
}

/**
 * Build the orchestrator Agent for a populate run.
 *
 * The orchestrator discovers entities via search_web + extract_pages, then
 * hands each entity off to a run_subagent for deep research and row insertion.
 * It has no write tools itself — all dataset writes go through run_subagent.
 *
 * A fresh orchestrator (and extract tool with its per-run dedup set) is
 * constructed per workflow run; do not cache.
 */
export function buildPopulateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  datasetName: string,
  description: string,
): Agent {
  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Orchestrator",
    instructions: buildOrchestratorInstructions(env.BIGSET_POPULATE_TARGET_ROWS),
    model: openrouter(env.BIGSET_ORCHESTRATOR_MODEL),
    tools: {
      search_web: searchWebTool,
      extract_pages: buildExtractTool(datasetName, description, columns),
      run_subagent: buildSubagentTool(
        authorizedDatasetId,
        authContext,
        columns,
      ),
    },
  });
}
