import type { DatasetSpec, ExtractedRecord, SourceTriageResult } from "../models/schemas.js";
import type { ScoreRecordContext } from "./score-record.js";

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** Confidence for one populated field from its evidence URL and row-level signals. */
export function confidenceForField(
  fieldName: string,
  record: ExtractedRecord,
  context: ScoreRecordContext,
): number {
  const extraction = record.extraction_confidence ?? 0.85;
  const evidenceForField = record.evidence.filter((item) => item.field === fieldName);

  if (evidenceForField.length === 0) {
    const fromAgent = record.source_urls.some((url) =>
      context.agentExtractedUrls.has(url),
    );
    return Math.min(1, Math.max(0, extraction * (fromAgent ? 0.72 : 0.78)));
  }

  const urlScores = evidenceForField
    .map((item) => {
      const triage = context.triageByUrl.get(item.url);
      const source = triage?.source_data_confidence ?? 0.65;
      const routing = triage?.confidence ?? 0.7;
      return source * 0.7 + routing * 0.15 + extraction * 0.15;
    })
    .filter((value) => Number.isFinite(value));

  if (urlScores.length === 0) {
    return Math.min(1, Math.max(0, extraction * 0.8));
  }

  return Math.min(
    1,
    Math.max(0, urlScores.reduce((sum, value) => sum + value, 0) / urlScores.length),
  );
}

export function computeFieldConfidences(
  spec: DatasetSpec,
  record: ExtractedRecord,
  context: ScoreRecordContext,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const col of spec.columns) {
    if (isEmpty(record.row[col.name])) continue;
    const score = confidenceForField(col.name, record, context);
    out[col.name] = Math.round(score * 1000) / 1000;
  }
  return out;
}

export function aggregateRecordConfidence(
  spec: DatasetSpec,
  fieldConfidences: Record<string, number>,
  requiredOnly = true,
): number {
  const columns = spec.columns.filter((col) =>
    requiredOnly ? col.required : true,
  );
  const scores = columns
    .map((col) => fieldConfidences[col.name])
    .filter((value): value is number => value !== undefined);

  if (scores.length === 0) return 0;
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return Math.round(mean * 1000) / 1000;
}
