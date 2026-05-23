import { config } from "../config.js";
import { completeJson } from "../integrations/openrouter.js";
import { sourceStatusSchema } from "../models/source-status.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import {
  sourceTriageResultSchema,
  type DatasetSpec,
  type FetchedPage,
  type SourceTriageResult,
} from "../models/schemas.js";
import {
  applyPromptSourcePolicyToTriageResult,
  derivePromptSourcePolicy,
} from "./source-policy.js";

const TRIAGE_SYSTEM = `You are the Source Triage Agent for a web data collection pipeline.

Classify each fetched web page to decide how the pipeline should process it.

Status definitions:
- extract_now: Page already contains a usable list/table or enough inline data to extract rows directly.
- requires_navigation: Data exists but requires clicking through menus, pagination, tabs, or multi-step browsing.
- requires_form_submission: Data requires filling and submitting a search/filter form.
- requires_detail_page_followup: Page is an index; each item needs opening a detail page to get full fields.
- irrelevant: Page is unrelated to the dataset intent.
- duplicate: Page largely repeats data already covered (same listings, mirror content).
- blocked: Login wall, CAPTCHA, access denied, or bot block.
- low_value: Related but unlikely to yield useful rows (thin content, ads-only, generic homepage).

Rules:
- Prefer extract_now when markdown already has list/table-style content matching row_grain.
- Use requires_* statuses when static fetch text is clearly incomplete for the schema.
- Mark duplicate only when the page would not yield any NEW rows beyond known_entities (if provided): same listings or mirror content with no additional primary keys visible. If the page may list entities not in known_entities, prefer extract_now or partial yield instead of duplicate.
- source_data_confidence: how confident you are that accurate, complete rows can be extracted (0–1).
- expected_yield: "complete" if full rows likely available inline; "partial" if only some fields; "none" if no useful rows.
- confidence: your confidence in this triage classification itself (routing), not data quality.
- When workflow_memory is provided: use domain_stats_top (high avg_completeness and avg_confidence) as strong extract_now signals; domain_stats_weak suggests blocked, low_value, or partial-only unless content clearly matches intent.
- Return ONLY JSON`;

function truncate(text: string): string {
  if (text.length <= config.maxPageChars) return text;
  return `${text.slice(0, config.maxPageChars)}\n\n[truncated]`;
}

export async function triagePage(options: {
  userPrompt: string;
  spec: DatasetSpec;
  page: FetchedPage;
  knownEntityKeys?: string[];
  memory?: WorkflowMemory;
}): Promise<SourceTriageResult> {
  const pageUrl = options.page.final_url || options.page.url;

  const result = await completeJson({
    label: `triage:${pageUrl}`,
    schema: sourceTriageResultSchema,
    messages: [
      { role: "system", content: TRIAGE_SYSTEM },
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
            text: truncate(options.page.text),
          },
          output_shape: {
            url: "string",
            final_url: "string",
            title: "string",
            status: "extract_now | requires_navigation | ...",
            confidence: "0-1 triage routing confidence",
            source_data_confidence: "0-1 expected data accuracy if extracted",
            expected_yield: "complete | partial | none",
            reasoning: "string",
            suggested_action: "optional string",
          },
        }),
      },
    ],
  });

  const normalizedResult = {
    ...result,
    url: options.page.url,
    final_url: pageUrl,
    title: options.page.title || result.title,
    status: sourceStatusSchema.parse(result.status),
  };
  return applyPromptSourcePolicyToTriageResult(
    normalizedResult,
    derivePromptSourcePolicy(options.userPrompt),
  );
}
