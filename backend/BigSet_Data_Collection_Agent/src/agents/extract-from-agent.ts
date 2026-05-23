import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";
import {
  buildLlmExtractionResultSchema,
  finalizeExtractedRecords,
  type LlmExtractionRecord,
} from "./extract.js";

/**
 * Parses one Tinyfish agent result JSON per call (see process-pages.ts agent branch).
 * Not used for fetched-page markdown; that path uses extractFromPage.
 */

const EXTRACT_AGENT_SYSTEM = `You are the Extraction Agent parsing output from a Tinyfish browser automation run.

Convert the agent result JSON into dataset records matching the schema.

Rules:
- Only include facts present in the agent result. Do not invent values.
- row keys must match spec column names exactly.
- For number columns, numeric values only (unit is in the column name).
- evidence: field, quote, and url for fields you populated when you have a supporting quote (url = where that quote was found; use page_url when from this page). Not required for every column.
- Do not return source_urls.
- extraction_confidence (0–1) per record when possible.
- Provenance URL columns: set per row to the URL where that row's data came from (use page_url when appropriate).
- If the agent result has no usable rows, return an empty records array.
- Return ONLY JSON`;

export async function extractFromAgentResult(options: {
  spec: DatasetSpec;
  pageUrl: string;
  agentResult: Record<string, unknown> | null;
  focusFields?: string[];
  memory?: WorkflowMemory;
}): Promise<ExtractedRecord[]> {
  if (!options.agentResult || Object.keys(options.agentResult).length === 0) {
    return [];
  }

  const result = await completeJson({
    label: `extract_agent:${options.pageUrl}`,
    schema: buildLlmExtractionResultSchema(options.spec),
    messages: [
      { role: "system", content: EXTRACT_AGENT_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          dataset_spec: {
            intent_summary: options.spec.intent_summary,
            row_grain: options.spec.row_grain,
            columns: options.spec.columns,
          },
          page_url: options.pageUrl,
          agent_result: options.agentResult,
          focus_fields: options.focusFields ?? [],
          workflow_memory: options.memory
            ? memoryContextForAgents(options.memory)
            : undefined,
          output_shape: {
            records: [
              {
                row: { column_name: "value or null" },
                evidence: [{ field: "column_name", url: "string", quote: "string" }],
                extraction_confidence: "0-1 number",
              },
            ],
          },
        }),
      },
    ],
  });

  return finalizeExtractedRecords(
    result.records as LlmExtractionRecord[],
    options.pageUrl,
    options.spec,
  );
}
