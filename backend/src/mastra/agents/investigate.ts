import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapModelWithTokenLimit } from "../model-wrapper.js";
import { buildPopulateTools } from "../tools/dataset-tools.js";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildInvestigateInstructions(columns: PopulateColumn[]): string {
  const columnNames = columns.map((c) => c.name);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `You research one entity and insert one row. Be fast — you have very few steps.

Columns:
${columnsDesc}

RULES:
- Do NOT fetch the same URL twice. If a fetch worked, use the data you got.
- You have at most 6 tool calls total. Budget them: 1 fetch + 1 search + 1 fetch + 1 insert = done.
- ALWAYS insert a row, even if some fields are incomplete. Use "" for unknown fields. Partial real data is better than no row.
- Never fabricate values. Use "" for anything you cannot verify.
- For every field value you extract and fill in "data", you MUST record the cell-level provenance (the source URL, the search query used to find it, and the exact text snippet context showing the value) in the "provenance" parameter of insert_row/update_row.
- insert_row rejects duplicates based on primary key columns. If you get a "Duplicate" error, do NOT retry — report INSERTED: false and move on.

TOOL CALL FORMAT — every tool call argument must be a JSON object wrapped in curly braces:
  search_web: {"query": "your search terms"}
  fetch_page: {"url": "https://example.com"}
  insert_row: {"data": {${columnNames.map((n) => `"${n}": "value"`).join(", ")}}, "sources": ["https://url-you-fetched.com"], "provenance": {${columnNames.map((n) => `"${n}": {"url": "https://url-you-fetched.com", "query": "search query used", "snippet": "exact context snippet from page"}`).join(", ")}}, "row_summary": "one line about this entity", "how_found": "step by step guide on how to extract the data so an agent in the future can do it too"}

WORKFLOW:
1. Fetch 1-2 of the provided URLs to get real data (if URLs were given).
2. If you need more, run ONE search and fetch the best result.
3. Call insert_row with whatever real data you have. Use "" for missing fields.
   Include "sources" (URLs you fetched), "provenance" (mapping of column names to their detailed source details), "row_summary" (one line about this entity), and "how_found" (a step by step guide on how you found this data. eg, 1. fetch the contents of this url "<insert url>", 2. Look for the pricing field, and title name field, 3. etc...)
4. Write your final response:
   INSERTED: true/false
   SUMMARY: one line
   CLUES: hints for finding more entities
   REASON: why you succeeded or what was missing
`;
}

/**
 * Build an investigate Agent that researches one entity and inserts a single row.
 *
 * Scoped to the same authorized dataset as the orchestrator via the same
 * closure-based security model (buildPopulateTools). A fresh instance is
 * constructed per investigate_row tool call; do not cache or share.
 */
export function buildInvestigateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
): Agent {
  const modelSlug = authContext.modelConfig!.investigateSubagent;

  const { insert_row } = buildPopulateTools(
    authorizedDatasetId,
    authContext,
  );
  return new Agent({
    id: "investigate-agent",
    name: "Dataset Investigate Agent",
    instructions: buildInvestigateInstructions(columns),
    model: wrapModelWithTokenLimit(openrouter(modelSlug)),

    tools: {
      insert_row,
      search_web: searchWebTool,
      fetch_page: fetchPageTool,
    },
  });
}
