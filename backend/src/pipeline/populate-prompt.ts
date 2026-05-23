import {
  buildPopulateFetchPlan,
  type PopulateAcquisitionResult,
  type PopulateFetchPlan,
} from "./populate-acquisition.js";
import type { DatasetContext } from "./populate.js";

export { buildPopulateFetchPlan, type PopulateFetchPlan };

export const populateAgentInstructions = `You are a dataset populate agent. Search is already done; your job is to fetch every source URL provided for this run and fill the table with verified facts.

Workflow:
1. fetch_page on each URL in the source list (work through the full list).
2. Extract facts only from fetched page content.
3. insert_row for each verified row, and return structured rows when useful.

Provenance (required for every row):
- Each row must come from a URL you fetched with fetch_page in this run.
- Record that exact URL in sourceUrls and in every evidence item's sourceUrl.
- evidence.quote must be a verbatim excerpt from that fetched page.
- For any column that stores a source or page URL, set it to the same fetch URL you used for that row.

Output:
- Prefer insert_row with the exact dataset column keys.
- You may also return { rows: [{ cells, sourceUrls, evidence, needsReview }] }.
- Do not call search_web.

Never invent rows, URLs, quotes, or cell values. Omit rows you cannot support from a fetched page.`;

export function buildPopulatePrompt(
  context: DatasetContext,
  maxRows: number,
  fetchPlan?: PopulateFetchPlan
): string {
  return [
    formatPopulateDatasetSection(context),
    formatPopulateColumnsSection(context),
    formatPopulateInsertRowSection(context),
    formatPopulateSourceUrlsSection(fetchPlan),
    formatPopulateLimitsSection(maxRows),
    formatPopulateRemindersSection(),
  ].join("\n\n");
}

export function buildPopulatePromptFromAcquisition(
  context: DatasetContext,
  maxRows: number,
  acquisition: PopulateAcquisitionResult
): string {
  return buildPopulatePrompt(
    context,
    maxRows,
    buildPopulateFetchPlan(acquisition)
  );
}

function formatPopulateDatasetSection(context: DatasetContext): string {
  return `## Dataset
- datasetId: ${context.datasetId}
- name: ${context.datasetName}
- description: ${context.description}`;
}

function formatPopulateColumnsSection(context: DatasetContext): string {
  const lines = context.columns.map(
    (column) =>
      `- ${column.name} (${column.type})${
        column.description ? `: ${column.description}` : ""
      }`
  );

  return `## Columns\n${lines.join("\n")}`;
}

function formatPopulateInsertRowSection(context: DatasetContext): string {
  const columnNames = context.columns.map((column) => column.name);

  return `## insert_row contract
- Keys must be exactly: ${JSON.stringify(columnNames)}
- Example: insert_row({ datasetId: "${context.datasetId}", data: { ${columnNames.map((name) => `"${name}": <value>`).join(", ")} } })`;
}

function formatPopulateSourceUrlsSection(
  fetchPlan?: PopulateFetchPlan
): string {
  if (!fetchPlan || fetchPlan.fetchUrls.length === 0) {
    return `## Source URLs
(none — do not invent rows; explain in validationIssues)`;
  }

  const lines = fetchPlan.fetchUrls.map(
    (entry, index) => `${index + 1}. ${entry.url}`
  );

  return `## Source URLs
Fetch every URL below (already ranked for this run; do not call search_web):
${lines.join("\n")}`;
}

function formatPopulateLimitsSection(maxRows: number): string {
  return `## Limits
- Up to ${maxRows} insert_row calls`;
}

function formatPopulateRemindersSection(): string {
  return `## Reminders
- fetch_page each listed URL before using it in any row.
- Every row must cite the fetch URL you used in sourceUrls and evidence.sourceUrl.
- Call insert_row for each verified row using datasetId from above.`;
}
