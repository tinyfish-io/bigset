import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildInvestigateInstructions(
  columns: PopulateColumn[],
  primaryKeyColumn: string,
): string {
  const columnNames = columns.map((c) => c.name);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `You research one specific entity to find values for its missing or low-confidence columns.
The entity already exists as a partial row — your job is to find what's missing.

━━ DATASET SCHEMA ━━
Columns:
${columnsDesc}

Primary key column: "${primaryKeyColumn}"
Tool call data/sources keys MUST be exactly: ${JSON.stringify(columnNames)}

━━ YOUR TASK ━━
You will be given:
- The entity's primary key value
- Its currently known data (columns already filled, with their confidence levels)
- The specific columns that are missing or low-confidence (your priority targets)

Search the web and fetch pages to find the missing values.
You may also improve existing low-confidence values if you find a better primary source.

━━ PROCEDURE ━━
1. Formulate targeted search queries — include the entity name and what you're looking for.
   Run 2–4 searches in parallel covering different angles.
2. Evaluate the search results. Fetch 2–4 of the most promising pages.
3. Extract values for the missing columns from what you find.
4. Call update_row_by_key once you have found values:
   - confidence: 1.0 = official primary source, 0.5 = aggregator, 0.2 = indirect mention
   - sources: map of column name → URL for each column you fill; "" for unfound columns
   - data: include ALL column keys, with "" for columns you still could not verify
5. If the first search round did not fill all missing columns, run 1–2 more targeted searches
   and fetch additional pages before your final update call.

━━ RULES ━━
1. REAL VALUES ONLY. Never fabricate or estimate. Leave "" for unverifiable columns.
2. UPDATE ONLY. The row already exists — always use update_row_by_key, never insert_row.
3. SOURCE ATTRIBUTION IS REQUIRED. Record the source URL for every value you fill.

━━ FINAL OUTPUT ━━
After all update calls are done, write a natural language summary with exactly these labels:

INSERTED: false
SUMMARY: <one-line description of what you found and updated>
CLUES: <hints for finding more data — specific URLs to other pages, search queries that worked,
        other related entities you noticed that might belong in the dataset>
REASON: <why you succeeded or what remained unfound>`;
}

/**
 * Build the investigate Agent that researches one specific entity
 * and fills its missing columns via update_row_by_key.
 *
 * The update tool is passed in (not built here) so the shared rowIndex
 * closure from investigate-tool.ts is preserved across all agent calls
 * within one workflow run.
 *
 * A fresh agent instance is constructed per investigate_entity call;
 * do not cache.
 */
export function buildInvestigateAgent(
  columns: PopulateColumn[],
  primaryKeyColumn: string,
  updateRowByKeyTool: ReturnType<typeof import("@mastra/core/tools").createTool>,
): Agent {
  return new Agent({
    id: "investigate-agent",
    name: "Dataset Investigate Agent",
    instructions: buildInvestigateInstructions(columns, primaryKeyColumn),
    model: openrouter("moonshotai/kimi-k2-0905"),
    tools: {
      search_web: searchWebTool,
      fetch_page: fetchPageTool,
      update_row_by_key: updateRowByKeyTool,
    },
  });
}
