import type { PopulateExtractionSpec } from "./populate-extraction-spec.js";
import type { PopulateCandidateRow } from "./populate-row.js";
import {
  coerceHttpUrl,
  isHttpUrl,
  uniqueHttpUrls,
} from "./populate-url-utils.js";

export function normalizePrimaryKey(
  value: unknown,
  columnName: string
): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .trim()
    .toLowerCase()
    .replace(
      /\b(?:incorporated|inc|corporation|corp|company|co|llc|ltd|limited|plc)\b\.?$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

export interface PopulateLlmExtractionRecord {
  row: Record<string, string | number | boolean | null>;
  evidence: Array<{ field: string; quote: string; url?: string }>;
  extraction_confidence?: number;
}

export function finalizePopulateLlmRecords(input: {
  records: PopulateLlmExtractionRecord[];
  pageUrl: string;
  spec: PopulateExtractionSpec;
}): PopulateCandidateRow[] {
  const rows: PopulateCandidateRow[] = [];

  for (const record of input.records) {
    const cells = { ...record.row };
    const sourceUrls = uniqueHttpUrls([
      input.pageUrl,
      ...record.evidence.map((item) => item.url),
      ...provenanceUrlsFromRow(cells, input.spec),
    ]);
    const evidence = record.evidence
      .filter((item) => coerceQuote(item.quote).length > 0)
      .map((item) => ({
        columnName: item.field,
        sourceUrl: coerceHttpUrl(item.url) ?? input.pageUrl,
        quote: coerceQuote(item.quote),
      }));

    const primaryKey = normalizePrimaryKey(
      cells[input.spec.primary_key],
      input.spec.primary_key
    );

    rows.push({
      cells,
      sourceUrls,
      evidence,
      needsReview: true,
      extractionConfidence: record.extraction_confidence ?? 0.5,
      primaryKey,
    });
  }

  return rows;
}

function provenanceUrlsFromRow(
  row: Record<string, string | number | boolean | null>,
  spec: PopulateExtractionSpec
): string[] {
  return spec.columns
    .filter((column) => /(url|website|link|page|source)/i.test(column.name))
    .map((column) => row[column.name])
    .filter((value): value is string => isHttpUrl(value));
}

function coerceQuote(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}
