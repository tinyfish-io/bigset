import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fetchPageTool } from "../tools/web-tools.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildTriageExtractInstructions(
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

  return `You are a triage-extract agent. You receive ONE source URL.
Fetch it, triage the page, and — if valuable — extract ALL matching entities as dataset rows.
Then dispatch investigation for any rows with missing or low-confidence columns.

━━ DATASET SCHEMA ━━
Columns:
${columnsDesc}

Primary key column: "${primaryKeyColumn}"
Tool call data/sources keys MUST be exactly: ${JSON.stringify(columnNames)}

━━ STEP 1: FETCH ━━
Call fetch_page for the URL provided in the prompt. Do not search — fetch only this one URL.

━━ STEP 2: TRIAGE ━━
After fetching, classify the page with one of these statuses:
- extract_now:          Readable content with entities matching the dataset schema.
- needs_browser_agent:  Page requires JavaScript rendering, login, or browser interaction
                        (blank page, login wall, JS-rendered SPA with no content in the HTML).
- needs_form_fill:      Page has a search form or requires user input before content appears.
- low_value:            Page is accessible but contains no entities matching the dataset topic.
- blocked:              403, 404, paywall, CAPTCHA, or access denial.

If NOT extract_now: skip steps 3–4 and go directly to FINAL OUTPUT.

━━ STEP 3: EXTRACT ━━
Read the FULL page content before writing any rows.
Identify ALL entities that match the dataset schema — do not stop after the first one.

After reading the full page, write ALL rows:
1. Check the existing rows list in the prompt.
2. For each entity identified:
   a. Primary key NOT in existing rows → call insert_row.
   b. Primary key IS in existing rows with LOWER confidence than yours → call update_row_by_key.
   c. Primary key IS in existing rows with EQUAL OR HIGHER confidence → skip.
3. For columns you cannot confirm from this page, use "" — never fabricate.
4. For every column you DO fill, record the source URL.

━━ STEP 4: INVESTIGATE MISSING COLUMNS ━━
After ALL inserts/updates are done, for each row that has one or more blank columns:
Call investigate_entity to dispatch an investigation agent for that row.

Provide as much context as possible in each investigate_entity call:
- The specific missing column names
- Any partial hints you noticed (a URL seen on the page, a founding year mentioned, etc.)
- The original source URL where you found the entity

The investigate agent will autonomously search and fill the gaps.
Prioritize rows with the most missing columns first.

━━ RULES ━━
1. REAL VALUES ONLY. Never fabricate — use "" for unverifiable columns.
2. SOURCE ATTRIBUTION. Record the URL for every column you fill.
3. READ THE FULL PAGE FIRST. Identify all entities before writing any rows.
4. NO SEARCHING. You only fetch the one URL provided — do not call search_web.

━━ FINAL OUTPUT ━━
After all work is done, write a natural language summary with exactly these labels:

TRIAGE_STATUS: <one of: extract_now | needs_browser_agent | needs_form_fill | low_value | blocked>
TRIAGE_REASON: <why you classified the page this way>
LEADS: <natural language description of other pages and entities you noticed;
        include specific URLs on their own lines with a dash (- https://...);
        suggest searches that might find more entities>
SOURCE_QUALITY: <was this source useful? what type of content, data quality, and coverage?>`;
}

/**
 * Build a fresh triage-extract Agent for one extract_rows call.
 *
 * The agent fetches one URL, triages the page, extracts all matching entities,
 * then dispatches investigate_entity for rows with missing columns.
 * It has no search capability — it only fetches the provided URL.
 *
 * All write tools (insert_row, update_row_by_key, investigate_entity) are
 * passed in from the buildExtractTool closure so the shared rowIndex is
 * maintained across all agents in one workflow run.
 *
 * A fresh agent instance is constructed per extract_rows call; do not cache.
 */
export function buildTriageExtractAgent(
  columns: PopulateColumn[],
  primaryKeyColumn: string,
  insertRowTool: ReturnType<typeof import("@mastra/core/tools").createTool>,
  updateRowByKeyTool: ReturnType<typeof import("@mastra/core/tools").createTool>,
  investigateEntityTool: ReturnType<typeof import("@mastra/core/tools").createTool>,
): Agent {
  return new Agent({
    id: "triage-extract-agent",
    name: "Dataset Triage-Extract Agent",
    instructions: buildTriageExtractInstructions(columns, primaryKeyColumn),
    model: openrouter("moonshotai/kimi-k2-0905"),
    tools: {
      fetch_page: fetchPageTool,
      insert_row: insertRowTool,
      update_row_by_key: updateRowByKeyTool,
      investigate_entity: investigateEntityTool,
    },
  });
}
