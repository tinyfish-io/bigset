import {
  buildPopulateTriageExtractSchema,
  populateSourceTriageResultSchema,
  type PopulateSourceTriageResult,
} from "./types.js";
import { completePopulateJson } from "./populate-llm-json.js";
import type { PopulateExtractionSpec } from "./populate-extraction-spec.js";
import { parsePopulateSourceStatus } from "./populate-source-status.js";
import type { PopulateFetchedPage } from "./populate-web-types.js";
import {
  finalizePopulateLlmRecords,
  type PopulateLlmExtractionRecord,
} from "./populate-extract-records.js";
import type { PopulateCandidateRow } from "./populate-row.js";

const TRIAGE_EXTRACT_PAGE_CHAR_LIMIT = 24_000;

const COMBINED_TRIAGE_EXTRACT_SYSTEM = `You are the Source Triage + Extraction Agent for a dataset populate pipeline.

Return JSON with exactly:
- triage_results (required)
- extraction_results (required; use empty records when not extracting)

Triage status:
- extract_now: Page has usable inline data — extract rows in this same response.
- requires_navigation / requires_form_submission / requires_detail_page_followup: Do NOT extract; suggest_action should describe what a browser agent should do.
- irrelevant / duplicate / blocked / low_value: Do NOT extract.

Triage fields: url, final_url, title, status, confidence, source_data_confidence, expected_yield (complete|partial|none), reasoning, optional suggested_action.

When status is extract_now:
- Extract only facts from page text. row keys must match spec column names.
- evidence: field, quote, optional url; extraction_confidence per record.

When status is NOT extract_now: extraction_results.records must be [].

Return ONLY JSON.`;

export interface TriageAndExtractPageResult {
  triage: PopulateSourceTriageResult;
  records: PopulateCandidateRow[];
}

export async function triageAndExtractPage(input: {
  userPrompt: string;
  spec: PopulateExtractionSpec;
  page: PopulateFetchedPage;
}): Promise<TriageAndExtractPageResult> {
  const pageUrl = input.page.final_url || input.page.url;
  const columnNames = input.spec.columns.map((column) => column.name);
  const schema = buildPopulateTriageExtractSchema(columnNames);

  const combined = await completePopulateJson({
    label: `populate-triage-extract:${pageUrl}`,
    schema,
    system: COMBINED_TRIAGE_EXTRACT_SYSTEM,
    user: JSON.stringify({
      user_prompt: input.userPrompt,
      dataset_spec: input.spec,
      page: {
        url: pageUrl,
        title: input.page.title,
        text: truncatePageText(input.page.text),
      },
      required_output_shape: {
        triage_results: "see system prompt",
        extraction_results: { records: "[] or row objects when extract_now" },
      },
    }),
  });

  const triage: PopulateSourceTriageResult = {
    ...combined.triage_results,
    url: input.page.url,
    final_url: pageUrl,
    title: input.page.title || combined.triage_results.title,
    status: parsePopulateSourceStatus(combined.triage_results.status),
  };

  let records: PopulateCandidateRow[] = [];
  if (triage.status === "extract_now") {
    records = finalizePopulateLlmRecords({
      records: combined.extraction_results.records as PopulateLlmExtractionRecord[],
      pageUrl,
      spec: input.spec,
    });
  }

  return { triage, records };
}

function truncatePageText(text: string): string {
  if (text.length <= TRIAGE_EXTRACT_PAGE_CHAR_LIMIT) {
    return text;
  }
  return `${text.slice(0, TRIAGE_EXTRACT_PAGE_CHAR_LIMIT)}\n\n[truncated]`;
}
