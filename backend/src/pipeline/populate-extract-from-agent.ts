import { buildPopulateLlmExtractionSchema } from "./types.js";
import { completePopulateJson } from "./populate-llm-json.js";
import type { PopulateExtractionSpec } from "./populate-extraction-spec.js";
import {
  finalizePopulateLlmRecords,
  type PopulateLlmExtractionRecord,
} from "./populate-extract-records.js";
import type { PopulateCandidateRow } from "./populate-row.js";

const EXTRACT_AGENT_SYSTEM = `You are the Extraction Agent parsing output from a Tinyfish browser automation run.

Convert the agent result JSON into dataset records matching the schema.

Rules:
- Only include facts present in the agent result. Do not invent values.
- row keys must match spec column names exactly.
- evidence: field, quote, and url when you have a supporting quote.
- extraction_confidence (0–1) per record when possible.
- If the agent result has no usable rows, return an empty records array.
- Return ONLY JSON`;

export async function extractFromTinyfishAgentResult(input: {
  userPrompt: string;
  spec: PopulateExtractionSpec;
  pageUrl: string;
  agentResult: Record<string, unknown> | null;
}): Promise<PopulateCandidateRow[]> {
  if (!input.agentResult || Object.keys(input.agentResult).length === 0) {
    return [];
  }

  const columnNames = input.spec.columns.map((column) => column.name);
  const schema = buildPopulateLlmExtractionSchema(columnNames);

  const result = await completePopulateJson({
    label: `populate-extract-agent:${input.pageUrl}`,
    schema,
    system: EXTRACT_AGENT_SYSTEM,
    user: JSON.stringify({
      user_prompt: input.userPrompt,
      dataset_spec: input.spec,
      page_url: input.pageUrl,
      agent_result: input.agentResult,
    }),
  });

  return finalizePopulateLlmRecords({
    records: result.records as PopulateLlmExtractionRecord[],
    pageUrl: input.pageUrl,
    spec: input.spec,
  });
}
