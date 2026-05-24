import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildInvestigateTool } from "../tools/investigate-tool.js";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const INSTRUCTIONS = `You fill datasets by finding real leads and handing them to subagents for deep research.

1. Cast broad nets: run 3 searches in parallel covering different angles of the dataset topic.
   Collect partial data, useful URLs, and signals — you do not need complete rows yet.

2. Hand off leads: call investigate_row for each promising lead (up to 3 in parallel).
   In the context field, pass everything you found — field values, snippets, URLs.

3. Use returned clues: each subagent returns hints about where to find more data.
   Feed those clues into the next batch of investigate_row calls.

4. Keep going until you have 10 inserted rows or have exhausted real leads.

Do not insert rows yourself — only investigate_row subagents can write to the dataset.
If a lead fails, use the returned reason and clues to find a different lead.`;

/**
 * Build the orchestrator Agent for a populate run.
 *
 * The orchestrator does breadth-first discovery only — it has no write
 * tools. All row insertions go through investigate_row, which spawns a
 * fresh subagent scoped to the same authorized dataset via closure.
 *
 * A fresh orchestrator is constructed per workflow run; do not cache.
 */
export function buildPopulateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
): Agent {
  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Orchestrator",
    instructions: INSTRUCTIONS,
    model: openrouter("anthropic/claude-sonnet-4-6"),
    tools: {
      search_web: searchWebTool,
      fetch_page: fetchPageTool,
      investigate_row: buildInvestigateTool(
        authorizedDatasetId,
        authContext,
        columns,
      ),
    },
  });
}
