import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildExtractTool } from "../tools/investigate-tool.js";
import { searchWebTool } from "../tools/web-tools.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildOrchestratorInstructions(targetRows: number): string {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.toLocaleString("en-US", { month: "long" });

  return `You fill datasets by searching the web and dispatching prioritized URLs to extraction agents.

━━ CURRENT DATE ━━
Today is ${currentMonth} ${currentYear} (${now.toISOString().slice(0, 10)}).
Always use this when formulating time-sensitive search queries.

━━ 1. SEARCH IN TWO ROUNDS ━━
Round 1: Run exactly 5 searches in parallel — wait for ALL results before continuing.
Round 2: Using new angles learned from Round 1, run exactly 10 more searches in parallel — wait for ALL.

Search query rules:
- Cover different angles: entity lists, official directories, aggregator sites, specific entity pages.
- TIME SENSITIVITY: If the dataset topic mentions "recent", "current", "latest", "this year",
  or a specific year, always include the relevant year or month explicitly in every query.
  Use ${currentYear} as "current year" — do NOT default to older years from your training data.
  Examples: "YC W2025 batch companies list", "AI startups ${currentYear} funding",
  "${currentMonth} ${currentYear} [topic] directory"

━━ 2. PRIORITIZE: SELECT TOP 5 URLS ━━
After both search rounds complete, evaluate ALL results and select the TOP 5 most valuable URLs.
Selection criteria:
- title:     Names a list, directory, or specific entity matching the dataset?
- snippet:   Mentions real column values (prices, contacts, dates, categories)?
- url:       Official site, authoritative directory, or known reputable domain?
- diversity: Choose URLs from DIFFERENT domains — do not pick 5 from the same site.

Dispatch these TOP 5 as 5 SEPARATE extract_rows calls in parallel — exactly 1 URL per call.
Wait for ALL 5 to complete before proceeding.

━━ 3. CHECK PROGRESS WITH list_rows ━━
After each batch of extract_rows calls completes, call list_rows to see the current dataset state.
list_rows shows you:
  - How many rows are complete vs. incomplete
  - Which specific columns are still missing for each entity

Use this to:
  a. Determine whether you have reached ${targetRows} complete rows (stop condition a).
  b. Identify which entities still need data — use this context to prioritize future searches.

━━ 4. CONTINUE DISPATCHING NEW URLS ━━
After checking progress, continue with new URLs from:
  Leads from extract_rows: Each result returns a "leads" field with natural language descriptions
    of other pages and entities discovered. Read these carefully and extract specific URLs to dispatch.
  New searches: Run additional searches if more coverage is needed.

Dispatch further batches in parallel — no limit on batch size.
Each call returns a triage_status: "extract_now" means the page had useful content;
"needs_browser_agent" / "needs_form_fill" / "low_value" / "blocked" mean the page was skipped.

DEDUPLICATION: Track every URL you dispatch to extract_rows. Never send the same URL twice
in one run, even if it appears in multiple leads or search results.

━━ 5. STOP CONDITIONS ━━
Stop when ANY of the following is true:
  a) list_rows shows complete rows ≥ ${targetRows}.
  b) 2 consecutive batches produced NO increase in complete rows per list_rows.
     — "batch" means one parallel round of extract_rows calls, waited for together.
     — Track explicitly: after each batch, record the complete row count from list_rows.
       If it did not increase from the previous batch, that is one stagnant batch.
       Two stagnant batches in a row → stop immediately.

Do NOT fetch pages yourself — only extract_rows agents fetch pages and write data.
Use search result titles, snippets, and URLs to make all prioritization decisions.`;
}

/**
 * Build the orchestrator Agent for a populate run.
 *
 * The orchestrator searches only — it has no fetch or write tools.
 * All page fetching, entity extraction, and row insertions happen inside
 * triage-extract subagents (via extract_rows), which in turn spawn
 * investigate subagents for rows with missing columns.
 *
 * Both extract_rows and list_rows share the same in-memory rowIndex closure
 * returned by buildExtractTool, making list_rows an accurate real-time
 * view of dataset state without a Convex round-trip.
 *
 * A fresh orchestrator is constructed per workflow run; do not cache.
 */
export function buildPopulateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  targetRows: number = Number(process.env.BIGSET_POPULATE_TARGET_ROWS || "20"),
): Agent {
  const { extractRowsTool, listRowsTool } = buildExtractTool(
    authorizedDatasetId,
    authContext,
    columns,
    targetRows,
  );

  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Orchestrator",
    instructions: buildOrchestratorInstructions(targetRows),
    model: openrouter("moonshotai/kimi-k2-0905"),
    tools: {
      search_web: searchWebTool,
      extract_rows: extractRowsTool,
      list_rows: listRowsTool,
    },
  });
}
