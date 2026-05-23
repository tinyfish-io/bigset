import { config } from "../config.js";
import { canonicalRecordId } from "../merge/records.js";
import type { RecordQuality, RecordStatus } from "../models/quality.js";
import type { DatasetSpec, ExtractedRecord, SourceTriageResult } from "../models/schemas.js";
import {
  aggregateRecordConfidence,
  computeFieldConfidences,
} from "./field-confidence.js";

export interface ScoreRecordContext {
  triageByUrl: Map<string, SourceTriageResult>;
  agentExtractedUrls: Set<string>;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function evidenceCoverage(
  spec: DatasetSpec,
  record: ExtractedRecord,
): { ratio: number; fieldsWithoutEvidence: string[] } {
  const nonNullFields = spec.columns.filter((col) => !isEmpty(record.row[col.name]));
  if (nonNullFields.length === 0) {
    return { ratio: 1, fieldsWithoutEvidence: [] };
  }

  const evidenced = new Set(record.evidence.map((item) => item.field));
  const fieldsWithoutEvidence = nonNullFields
    .filter((col) => !evidenced.has(col.name))
    .map((col) => col.name);

  const ratio =
    (nonNullFields.length - fieldsWithoutEvidence.length) / nonNullFields.length;

  return { ratio, fieldsWithoutEvidence };
}

function minSourceConfidence(
  record: ExtractedRecord,
  triageByUrl: Map<string, SourceTriageResult>,
): number {
  const scores = record.source_urls
    .map((url) => triageByUrl.get(url)?.source_data_confidence)
    .filter((value): value is number => value !== undefined);

  if (scores.length === 0) return 0.65;
  return Math.min(...scores);
}

export function scoreRecord(
  spec: DatasetSpec,
  record: ExtractedRecord,
  context: ScoreRecordContext,
  recordId: string,
): RecordQuality {
  const requiredColumns = spec.columns.filter((col) => col.required);
  const optionalColumns = spec.columns.filter((col) => !col.required);

  const missingRequired = requiredColumns
    .filter((col) => isEmpty(record.row[col.name]))
    .map((col) => col.name);
  const missingOptional = optionalColumns
    .filter((col) => isEmpty(record.row[col.name]))
    .map((col) => col.name);

  const filledRequired =
    requiredColumns.length > 0
      ? requiredColumns.length - missingRequired.length
      : spec.columns.length;
  const completenessPct =
    requiredColumns.length > 0
      ? filledRequired / requiredColumns.length
      : spec.columns.filter((col) => !isEmpty(record.row[col.name])).length /
          Math.max(spec.columns.length, 1);

  const { ratio: evidenceRatio, fieldsWithoutEvidence } = evidenceCoverage(
    spec,
    record,
  );
  const sourceConfidence = minSourceConfidence(record, context.triageByUrl);
  const extractionConfidence = record.extraction_confidence ?? 0.85;
  const fieldConfidences = computeFieldConfidences(spec, record, context);

  const requiredFieldConfidence = aggregateRecordConfidence(
    spec,
    fieldConfidences,
    true,
  );
  const legacyBlend = Math.min(
    1,
    Math.max(
      0,
      completenessPct * 0.35 +
        sourceConfidence * 0.25 +
        extractionConfidence * 0.25 +
        evidenceRatio * 0.15,
    ),
  );
  const confidenceScore =
    requiredColumns.length > 0 && Object.keys(fieldConfidences).length > 0
      ? requiredFieldConfidence
      : legacyBlend;

  const reviewReasons: string[] = [];
  if (missingRequired.length > 0) {
    reviewReasons.push(
      `missing required fields: ${missingRequired.join(", ")}`,
    );
  }
  if (fieldsWithoutEvidence.length > 0) {
    reviewReasons.push(
      `fields without evidence: ${fieldsWithoutEvidence.join(", ")}`,
    );
  }
  if (sourceConfidence < config.qualitySourceConfidenceThreshold) {
    reviewReasons.push(
      `low source data confidence (${sourceConfidence.toFixed(2)})`,
    );
  }
  if (extractionConfidence < config.qualityExtractionConfidenceThreshold) {
    reviewReasons.push(
      `low extraction confidence (${extractionConfidence.toFixed(2)})`,
    );
  }

  const fromAgent = record.source_urls.some((url) =>
    context.agentExtractedUrls.has(url),
  );
  if (fromAgent && extractionConfidence < 0.8) {
    reviewReasons.push("browser agent extraction — verify manually");
  }

  let recordStatus: RecordStatus;
  if (missingRequired.length > 0) {
    recordStatus = "partial";
  } else if (
    confidenceScore < config.qualityLowConfidenceThreshold ||
    fieldsWithoutEvidence.length > 0
  ) {
    recordStatus = "low_confidence";
  } else {
    recordStatus = "complete";
  }

  const needsReview =
    recordStatus === "partial" ||
    recordStatus === "low_confidence" ||
    confidenceScore < config.qualityReviewThreshold;

  return {
    record_id: recordId,
    record_status: recordStatus,
    needs_review: needsReview,
    completeness_pct: Math.round(completenessPct * 1000) / 1000,
    confidence_score: Math.round(confidenceScore * 1000) / 1000,
    field_confidences: fieldConfidences,
    missing_required_fields: missingRequired,
    missing_optional_fields: missingOptional,
    fields_without_evidence: fieldsWithoutEvidence,
    review_reasons: reviewReasons,
  };
}

export function scoreRecords(
  spec: DatasetSpec,
  records: ExtractedRecord[],
  context: ScoreRecordContext,
): RecordQuality[] {
  return records.map((record) => {
    const recordId =
      canonicalRecordId(record, spec) ??
      `unkeyed:${JSON.stringify(record.row).slice(0, 80)}`;
    return scoreRecord(spec, record, context, recordId);
  });
}
