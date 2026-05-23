import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalRecordId } from "../merge/records.js";
import type { RecordQuality } from "../models/quality.js";
import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

const QUALITY_COLUMNS = [
  "record_id",
  "record_status",
  "needs_review",
  "completeness_pct",
  "confidence_score",
  "missing_required_fields",
  "review_reasons",
] as const;

function fieldConfidenceColumns(spec: DatasetSpec): string[] {
  return spec.columns
    .filter((col) => col.required)
    .map((col) => `${col.name}_confidence`);
}

function qualityCells(
  quality: RecordQuality | undefined,
  spec: DatasetSpec,
): string[] {
  if (!quality) {
    return [
      ...QUALITY_COLUMNS.map(() => ""),
      ...fieldConfidenceColumns(spec).map(() => ""),
    ];
  }
  const requiredConfidenceCells = spec.columns
    .filter((col) => col.required)
    .map((col) => {
      const value = quality.field_confidences[col.name];
      return escapeCsv(value !== undefined ? String(value) : "");
    });

  return [
    escapeCsv(quality.record_id),
    escapeCsv(quality.record_status),
    escapeCsv(quality.needs_review ? "true" : "false"),
    escapeCsv(String(quality.completeness_pct)),
    escapeCsv(String(quality.confidence_score)),
    escapeCsv(quality.missing_required_fields.join("; ")),
    escapeCsv(quality.review_reasons.join("; ")),
    ...requiredConfidenceCells,
  ];
}

export async function writeResultsCsv(
  path: string,
  spec: DatasetSpec,
  records: ExtractedRecord[],
  qualityByRecordId?: Map<string, RecordQuality>,
): Promise<void> {
  const columnNames = spec.columns.map((c) => c.name);
  const metaColumns = ["primary_source_url", "all_source_urls"];
  const includeQuality = qualityByRecordId !== undefined;
  const header = [
    ...columnNames,
    ...metaColumns,
    ...(includeQuality
      ? [...QUALITY_COLUMNS, ...fieldConfidenceColumns(spec)]
      : []),
  ];

  const lines = [header.map(escapeCsv).join(",")];

  for (const record of records) {
    const cells = columnNames.map((name) =>
      escapeCsv(cellValue(record.row[name])),
    );
    const primarySource = record.source_urls[0] ?? "";
    const allSources = record.source_urls.join(" | ");
    cells.push(escapeCsv(primarySource), escapeCsv(allSources));

    if (includeQuality) {
      const recordId = canonicalRecordId(record, spec);
      const quality = recordId ? qualityByRecordId.get(recordId) : undefined;
      cells.push(...qualityCells(quality, spec));
    }

    lines.push(cells.join(","));
  }

  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

export async function writeEvidenceJsonl(
  path: string,
  spec: DatasetSpec,
  records: ExtractedRecord[],
  qualityByRecordId?: Map<string, RecordQuality>,
): Promise<void> {
  const lines = records.map((record) => {
    const recordId = canonicalRecordId(record, spec);
    const payload: Record<string, unknown> = {
      row: record.row,
      evidence: record.evidence,
      source_urls: record.source_urls,
    };
    if (record.extraction_confidence !== undefined) {
      payload.extraction_confidence = record.extraction_confidence;
    }
    if (recordId && qualityByRecordId?.has(recordId)) {
      const quality = qualityByRecordId.get(recordId)!;
      payload.quality = quality;
      if (Object.keys(quality.field_confidences).length > 0) {
        payload.field_confidences = quality.field_confidences;
      }
    }
    return JSON.stringify(payload);
  });

  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
}

export function qualityMapFromReport(
  qualities: RecordQuality[],
): Map<string, RecordQuality> {
  return new Map(qualities.map((quality) => [quality.record_id, quality]));
}

export async function writeSegmentedRecordCsvs(
  root: string,
  spec: DatasetSpec,
  records: ExtractedRecord[],
  qualities: RecordQuality[],
): Promise<void> {
  const qualityById = qualityMapFromReport(qualities);
  const recordIdFor = (record: ExtractedRecord) => canonicalRecordId(record, spec);

  const complete = records.filter((record) => {
    const id = recordIdFor(record);
    return id && qualityById.get(id)?.record_status === "complete";
  });
  const partial = records.filter((record) => {
    const id = recordIdFor(record);
    return id && qualityById.get(id)?.record_status === "partial";
  });
  const lowConfidence = records.filter((record) => {
    const id = recordIdFor(record);
    return id && qualityById.get(id)?.record_status === "low_confidence";
  });
  const needingReview = records.filter((record) => {
    const id = recordIdFor(record);
    return id && qualityById.get(id)?.needs_review === true;
  });

  await writeResultsCsv(
    join(root, "records_complete.csv"),
    spec,
    complete,
    qualityById,
  );
  await writeResultsCsv(
    join(root, "records_partial.csv"),
    spec,
    partial,
    qualityById,
  );
  await writeResultsCsv(
    join(root, "records_low_confidence.csv"),
    spec,
    lowConfidence,
    qualityById,
  );
  await writeResultsCsv(
    join(root, "records_needing_review.csv"),
    spec,
    needingReview,
    qualityById,
  );
}

export async function writeUnkeyedRecordsJsonl(
  path: string,
  records: ExtractedRecord[],
): Promise<void> {
  const lines = records.map((record) => JSON.stringify(record));
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
}
