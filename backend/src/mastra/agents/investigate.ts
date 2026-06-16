import { Agent } from "@mastra/core/agent";
import { createLanguageModel, type LlmProviderConfig } from "../../config/llm.js";
import { buildPopulateTools } from "../tools/dataset-tools.js";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

interface InvestigateAgentOptions {
  insertDefaults?: {
    data?: Record<string, unknown>;
    lockColumns?: string[];
    sources?: string[];
    cellSources?: Record<string, string[]>;
    rowSummary?: string;
    howFoundPrefix?: string;
  };
  membershipSourceHint?: string;
}

function buildInvestigateInstructions(
  columns: PopulateColumn[],
  membershipSourceHint?: string,
): string {
  const columnNames = columns.map((c) => c.name);
  const dataExample = columnNames
    .map((n) => `{"column": "${n}", "value": "value"}`)
    .join(", ");
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.nullable === false ? " [REQUIRED]" : c.nullable === true ? " [OPTIONAL]" : ""}${c.validationRegex ? ` validation_regex=${JSON.stringify(c.validationRegex)}` : ""}${c.normalizationHint ? ` normalization_hint=${JSON.stringify(c.normalizationHint)}` : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `You research one entity and insert one row. Work efficiently, but do not sacrifice data quality.

Columns:
${columnsDesc}
${membershipSourceHint ? `\nAuthoritative membership source: ${membershipSourceHint}` : ""}

RULES:
- Do NOT fetch the same URL twice. If a fetch worked, use the data you got.
- Try to stay under 6 tool calls when that is enough, but do not stop early if more searching/fetching is needed to verify requested columns.
- Your goal is to fill every column from real, source-backed evidence. Some columns may be impossible to verify; use "" only after a reasonable targeted attempt.
- Never fabricate values. Use "" for anything you cannot verify.
- Treat any browser-extracted candidate values in the prompt as hints, not truth. Re-verify primary key values and source-backed facts before inserting.
- If a primary key cannot be verified from a real source, do not insert the row. For URL primary keys, fetch or otherwise verify the exact current URL; if it 404s, redirects to a different entity, or cannot be justified by source-backed evidence, report INSERTED: false.
- If an authoritative membership source is listed, primary keys must be justified by that source family. Other sources may enrich fields, but they cannot prove that the entity belongs in the dataset.
- Optional/nullable columns should still be researched. Optional only means the row can be inserted blank if you cannot verify the value.
- Normalize values to the schema contract before inserting. Follow validation_regex and normalization_hint when present.
- For every primary key, include cell_sources that justify that exact primary-key value. For URL primary keys, cell_sources must include the exact verified URL.
- insert_row rejects duplicates based on primary key columns. If you get a "Duplicate" error, do NOT retry — report INSERTED: false and move on.

TOOL CALL FORMAT — every tool call argument must be a JSON object wrapped in curly braces:
  search_web: {"query": "your search terms"}
  fetch_page: {"url": "https://example.com"}
  insert_row: {"data": [${dataExample}], "sources": ["https://url-you-fetched.com"], "cell_sources": [{"column": "column_name", "sources": ["https://url-that-justifies-this-cell.com"]}], "row_summary": "one line about this entity", "how_found": "step by step guide on how to extract the data so an agent in the future can do it too"}

WORKFLOW:
1. Fetch 1-2 of the provided URLs to get real data (if URLs were given).
2. For unresolved columns, run targeted searches/fetches until the value is verified, clearly unavailable, or further tool calls are unlikely to help.
3. Call insert_row with the best verified row you can produce. Use "" for any field that remains unknown after the targeted attempt.
   Include "sources" (URLs you fetched for the row), "cell_sources" (only URLs that justify the exact cell value for that column), "row_summary" (one line about this entity), and "how_found" (a step by step guide on how you found this data. eg, 1. fetch the contents of this url "<insert url>", 2. Look for the pricing field, and title name field, 3. etc...)
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
  llmConfig: LlmProviderConfig,
  options: InvestigateAgentOptions = {},
): Agent {
  const modelSlug = authContext.modelConfig!.investigateSubagent;

  const { insert_row } = buildPopulateTools(
    authorizedDatasetId,
    authContext,
    {
      ...options,
      columns,
      enforcePrimaryKeySources: true,
      membershipSourceHint: options.membershipSourceHint,
    },
  );
  return new Agent({
    id: "investigate-agent",
    name: "Dataset Investigate Agent",
    instructions: buildInvestigateInstructions(columns, options.membershipSourceHint),
    model: createLanguageModel(llmConfig, modelSlug),

    tools: {
      insert_row,
      search_web: searchWebTool,
      fetch_page: fetchPageTool,
    },
  });
}
