import { z } from "zod";
import { config } from "../config.js";
import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import { sourceStatusSchema } from "../models/source-status.js";
import {
  sourceTriageResultSchema,
  type DatasetSpec,
  type ExtractedRecord,
  type FetchedPage,
  type SourceTriageResult,
} from "../models/schemas.js";
import {
  buildLlmExtractionResultSchema,
  finalizeExtractedRecords,
  type LlmExtractionRecord,
} from "./extract.js";

/** Page text budget for combined triage + extract (default 2× MAX_PAGE_CHARS). */
export function triageExtractPageCharLimit(): number {
  return config.triageExtractMaxPageChars;
}

function truncatePageText(text: string): string {
  const limit = triageExtractPageCharLimit();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated]`;
}

const COMBINED_TRIAGE_EXTRACT_SYSTEM = `You are the Source Triage + Extraction Agent for a web data collection pipeline.

You MUST return JSON with exactly these top-level keys:
- "triage_results" — classification for this page (required)
- "extraction_results" — extracted rows (required object; use empty records when not extracting)

## triage_results

Classify the fetched page:

Status definitions:
- extract_now: Page already contains usable list/table or enough inline data to extract rows directly IN THIS SAME RESPONSE.
- requires_navigation: Data needs clicking menus, pagination, tabs, or multi-step browsing (do NOT extract).
- requires_form_submission: Data needs filling/submitting a form (do NOT extract).
- requires_detail_page_followup: Index page; detail pages needed (do NOT extract).
- irrelevant: Unrelated to dataset intent (do NOT extract).
- duplicate: Repeats known_entities with no new primary keys (do NOT extract).
- blocked: Login wall, CAPTCHA, access denied (do NOT extract).
- low_value: Related but unlikely to yield useful rows (do NOT extract).

Fields: url, final_url, title, status, confidence (routing), source_data_confidence (data quality if extracted), expected_yield (complete|partial|none), reasoning, optional suggested_action.

## extraction_results

ONLY populate records when triage_results.status is extract_now.

When status is extract_now:
- Extract facts supported by page text only. row keys must match spec column names.
- Use null for unknown values. Multiple records allowed per row_grain.
- evidence: field, quote, optional url; extraction_confidence per record.
- Do not return source_urls on records (added in post-processing).

When status is NOT extract_now:
- Set extraction_results.records to [] and omit notes or use a brief note explaining skip.

When workflow_memory is provided: use domain_stats_top / query_stats_top as positive signals; domain_stats_weak suggests caution.

Return ONLY JSON.`;

export function buildTriageExtractCombinedSchema(spec: DatasetSpec) {
  return z.object({
    triage_results: sourceTriageResultSchema,
    extraction_results: buildLlmExtractionResultSchema(spec),
  });
}

export type InlineExtractionArtifact = {
  records: ExtractedRecord[];
  notes?: string;
};

/** Per-source artifact: triage + inline extraction (if any). */
export type SourceTriageExtractOutcome = {
  url: string;
  final_url: string;
  triage_results: SourceTriageResult;
  extraction_results: InlineExtractionArtifact | null;
};

export interface TriageAndExtractPageResult {
  triage: SourceTriageResult;
  records: ExtractedRecord[];
  outcome: SourceTriageExtractOutcome;
}

export async function triageAndExtractPage(options: {
  userPrompt: string;
  spec: DatasetSpec;
  page: FetchedPage;
  knownEntityKeys?: string[];
  memory?: WorkflowMemory;
  focusFields?: string[];
}): Promise<TriageAndExtractPageResult> {
  const pageUrl = options.page.final_url || options.page.url;

  const combined = await completeJson({
    label: `triage-extract:${pageUrl}`,
    schema: buildTriageExtractCombinedSchema(options.spec),
    messages: [
      { role: "system", content: COMBINED_TRIAGE_EXTRACT_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          user_prompt: options.userPrompt,
          dataset_spec: {
            intent_summary: options.spec.intent_summary,
            row_grain: options.spec.row_grain,
            columns: options.spec.columns,
            extraction_hints: options.spec.extraction_hints,
          },
          known_entities: options.knownEntityKeys ?? [],
          workflow_memory: options.memory
            ? memoryContextForAgents(options.memory)
            : undefined,
          page: {
            url: pageUrl,
            title: options.page.title,
            text: truncatePageText(options.page.text),
          },
          ...(options.focusFields?.length
            ? {
                focus_fields: options.focusFields,
                instruction:
                  "Prioritize focus_fields when extracting under extract_now.",
              }
            : {}),
          required_output_shape: {
            triage_results: {
              url: "string",
              final_url: "string",
              title: "string",
              status: "extract_now | requires_* | irrelevant | ...",
              confidence: "0-1",
              source_data_confidence: "0-1",
              expected_yield: "complete | partial | none",
              reasoning: "string",
              suggested_action: "optional",
            },
            extraction_results: {
              records: "[] or row objects when extract_now",
              notes: "optional",
            },
          },
        }),
      },
    ],
  });

  const triage: SourceTriageResult = {
    ...combined.triage_results,
    url: options.page.url,
    final_url: pageUrl,
    title: options.page.title || combined.triage_results.title,
    status: sourceStatusSchema.parse(combined.triage_results.status),
  };

  let records: ExtractedRecord[] = [];
  let extractionArtifact: InlineExtractionArtifact | null = null;

  if (triage.status === "extract_now") {
    records = finalizeExtractedRecords(
      combined.extraction_results.records as LlmExtractionRecord[],
      pageUrl,
      options.spec,
    );
    extractionArtifact = {
      records,
      ...(combined.extraction_results.notes
        ? { notes: combined.extraction_results.notes }
        : {}),
    };
  }

  const outcome: SourceTriageExtractOutcome = {
    url: options.page.url,
    final_url: pageUrl,
    triage_results: triage,
    extraction_results: extractionArtifact,
  };

  return { triage, records, outcome };
}
