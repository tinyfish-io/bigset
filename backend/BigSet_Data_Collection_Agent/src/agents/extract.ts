import { z } from "zod";
import { config } from "../config.js";
import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import {
  extractedRecordSchema,
  fieldEvidenceSchema,
  type ColumnDef,
  type DatasetSpec,
  type ExtractedRecord,
  type FetchedPage,
} from "../models/schemas.js";

/**
 * Extraction paths in process-pages.ts:
 * - triageAndExtractPage (v1.5.2 default): combined triage + inline extract for extract_now.
 * - extractFromPage: triage disabled, agent-disabled fallback, combined failure fallback, legacy mode.
 * - extractFromAgentResult: Tinyfish agent JSON payload per call (separate module).
 *
 * LLM returns row + sparse evidence + extraction_confidence; code attaches evidence URLs
 * and source_urls. Provenance URL columns come from the LLM row values per record.
 */

const llmFieldEvidenceSchema = fieldEvidenceSchema
  .omit({ url: true })
  .extend({ url: z.string().optional() });

export type LlmExtractionRecord = {
  row: Record<string, string | number | boolean | null>;
  evidence: z.infer<typeof llmFieldEvidenceSchema>[];
  extraction_confidence?: number;
};

function columnValueSchema(
  column: ColumnDef,
): z.ZodType<string | number | boolean | null> {
  switch (column.type) {
    case "number":
      return z.union([z.number(), z.null()]);
    case "boolean":
      return z.union([z.boolean(), z.null()]);
    default:
      return z.union([z.string(), z.null()]);
  }
}

/** Explicit column keys so AI SDK structured output guides the model to populate row fields. */
export function buildLlmExtractionResultSchema(spec: DatasetSpec) {
  const rowShape: Record<string, z.ZodTypeAny> = {};
  for (const column of spec.columns) {
    rowShape[column.name] = columnValueSchema(column);
  }

  const llmExtractionRecordSchema = z.object({
    row: z.object(rowShape),
    evidence: z.array(llmFieldEvidenceSchema),
    extraction_confidence: z.number().min(0).max(1).optional(),
  });

  return z.object({
    records: z.array(llmExtractionRecordSchema),
    notes: z.string().optional(),
  });
}

const EXTRACTION_SYSTEM = `You are the Extraction Agent for a web data collection pipeline.

Extract structured records from the provided page content according to the dataset specification.

Rules:
- Only extract facts supported by the page text. Do not invent data.
- row keys must match spec column names exactly.
- For columns with type "number", store numeric values only (no unit text in the value; the unit is already in the column name).
- Use null for unknown values.
- Return multiple records if the page lists multiple entities matching row_grain.
- If the page has no relevant data, return an empty records array.
- evidence: include field, quote, and url for fields you populated when you have a supporting quote (url = where that quote was found; use the page URL when from this page). Not required for every column.
- Do not return source_urls on the record.
- extraction_confidence (0–1): how confident you are this row is accurate.
- Provenance URL columns (e.g. source_url, evidence_url, or columns described as where data was found): set each row's value to the URL where that row's facts came from — use the provided page URL when all fields for that row are from this page, or a more specific URL only if clearly stated on the page.
- Do not copy unrelated URLs into provenance columns (e.g. do not set source_url to the page URL when pricing_page_url already holds the pricing URL and source_url should cite where you read the plan).
- Return ONLY JSON`;

function truncatePageText(text: string): string {
  if (text.length <= config.maxPageChars) return text;
  return `${text.slice(0, config.maxPageChars)}\n\n[truncated]`;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function coerceEvidenceToColumnValue(
  column: ColumnDef,
  quote: string,
): string | number | boolean | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;

  switch (column.type) {
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (
        /\b(true|yes|active|hiring|looking for|open roles|open positions|join us|join our team|we(?:'re| are) hiring|see open roles)\b/.test(
          lower,
        )
      ) {
        return true;
      }
      if (
        /\b(false|no|not hiring|no careers|does not contain|lack of|without)\b/.test(
          lower,
        )
      ) {
        return false;
      }
      return null;
    }
    case "number": {
      const parsed = Number(trimmed.replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    default:
      return trimmed;
  }
}

function hydrateRowFromEvidence(
  row: Record<string, string | number | boolean | null>,
  evidence: Array<{ field: string; quote: string }>,
  spec: DatasetSpec,
): void {
  const columnByName = new Map(spec.columns.map((column) => [column.name, column]));

  for (const item of evidence) {
    if (isEmpty(row[item.field])) {
      const column = columnByName.get(item.field);
      if (!column) continue;
      const value = coerceEvidenceToColumnValue(column, item.quote);
      if (value !== null) {
        row[item.field] = value;
      }
    }
  }
}

/** Columns meant to hold a citation URL for where row data was found (not content URLs). */
export function isProvenanceUrlColumn(column: ColumnDef): boolean {
  const name = column.name.toLowerCase();
  if (name === "source_url" || name === "evidence_url") {
    return true;
  }
  if (name.endsWith("_source_url")) {
    return true;
  }
  const description = column.description.toLowerCase();
  return (
    name.includes("source") &&
    name.includes("url") &&
    (description.includes("evidence") ||
      description.includes("provenance") ||
      description.includes("where"))
  );
}

function provenanceUrlColumns(spec: DatasetSpec): ColumnDef[] {
  return spec.columns.filter(isProvenanceUrlColumn);
}

function collectSourceUrls(
  pageUrl: string,
  evidence: Array<{ url?: string }>,
): string[] {
  const urls = new Set<string>([pageUrl]);
  for (const item of evidence) {
    if (item.url?.startsWith("http")) {
      urls.add(item.url);
    }
  }
  return [...urls];
}

/** Attach evidence URLs and source_urls; keep LLM row and provenance values. */
export function finalizeExtractedRecord(
  record: LlmExtractionRecord,
  pageUrl: string,
  spec: DatasetSpec,
): ExtractedRecord {
  const row = { ...record.row };
  hydrateRowFromEvidence(row, record.evidence, spec);

  const evidence = record.evidence.map((item) => ({
    field: item.field,
    quote: item.quote,
    url: item.url?.trim() || pageUrl,
  }));

  for (const column of provenanceUrlColumns(spec)) {
    if (column.required && isEmpty(row[column.name])) {
      row[column.name] = pageUrl;
    }
  }

  const source_urls = collectSourceUrls(pageUrl, evidence);

  return extractedRecordSchema.parse({
    row,
    evidence,
    source_urls,
    ...(record.extraction_confidence !== undefined
      ? { extraction_confidence: record.extraction_confidence }
      : {}),
  });
}

export function finalizeExtractedRecords(
  records: LlmExtractionRecord[],
  pageUrl: string,
  spec: DatasetSpec,
): ExtractedRecord[] {
  return records.map((record) => finalizeExtractedRecord(record, pageUrl, spec));
}

export interface ExtractOptions {
  focusFields?: string[];
}

export async function extractFromPage(
  spec: DatasetSpec,
  page: FetchedPage,
  options: ExtractOptions & { memory?: WorkflowMemory } = {},
): Promise<ExtractedRecord[]> {
  if (page.error || !page.text.trim()) {
    return [];
  }

  const pageUrl = page.final_url || page.url;
  const result = await completeJson({
    label: `extraction:${pageUrl}`,
    schema: buildLlmExtractionResultSchema(spec),
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          dataset_spec: {
            intent_summary: spec.intent_summary,
            row_grain: spec.row_grain,
            columns: spec.columns,
            extraction_hints: spec.extraction_hints,
          },
          page: {
            url: pageUrl,
            title: page.title,
            text: truncatePageText(page.text),
          },
          ...(options.focusFields?.length
            ? {
                focus_fields: options.focusFields,
                instruction:
                  "Prioritize extracting focus_fields. Use null only when the page truly lacks that information.",
              }
            : {}),
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
            notes: "optional string",
          },
        }),
      },
    ],
  });

  return finalizeExtractedRecords(
    result.records as LlmExtractionRecord[],
    pageUrl,
    spec,
  );
}
