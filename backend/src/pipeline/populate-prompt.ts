import type { DatasetContext } from "./populate.js";

export const populateAgentInstructions = `You fill datasets with real data. Here's how:

1. Search the web for data that fits the dataset topic.
2. Fetch 1-2 pages to get details.
3. Call insert_row only for rows supported by search or fetched page content.
4. Also return structured rows with cells, sourceUrls, evidence, and needsReview.

Never make up rows or missing cell values. If you can't find enough real data, insert fewer rows and explain the gap in your final response.`;

export function buildPopulatePrompt(inputData: DatasetContext): string {
  const columnNames = inputData.columns.map((c) => c.name);
  const columnsDesc = inputData.columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `Dataset ID: ${inputData.datasetId}
Dataset: ${inputData.datasetName}
Description: ${inputData.description}

Columns:
${columnsDesc}

When calling insert_row, the data object keys MUST be exactly these strings (no backticks, no extra quotes):
${JSON.stringify(columnNames)}

Example insert_row call:
insert_row({ datasetId: "${inputData.datasetId}", data: { ${columnNames.map((n) => `"${n}": <value>`).join(", ")} } })

Search the web for real data about this topic. Then call insert_row for up to 10 source-backed rows.

Important:
- The dataset should be populated by insert_row tool calls whenever possible.
- Also return structured rows using this shape: { rows: [{ cells, sourceUrls, evidence, needsReview }] }.
- Every structured row cells object must contain exactly the requested column keys above.
- Every structured row must include sourceUrls and evidence quotes copied from search_web or fetch_page results.
- For every verified row, call insert_row with the exact datasetId above.
- Never invent rows or cell values.
- If sources only support fewer than 10 rows, insert only the verified rows and explain what was missing.`;
}
