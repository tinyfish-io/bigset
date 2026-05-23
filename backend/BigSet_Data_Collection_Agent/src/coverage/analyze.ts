import { canonicalRecordId } from "../merge/records.js";
import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";

export interface FieldGap {
  column: string;
  description: string;
  missing_count: number;
  missing_pct: number;
  /** Partial rows missing this field (for repair query context). */
  example_rows: Record<string, string | number | boolean | null>[];
}

export interface CoverageReport {
  total_records: number;
  required_columns: string[];
  field_gaps: FieldGap[];
  should_repair: boolean;
  /** Rows with all required fields present. */
  complete_count: number;
  /** Rows missing at least one required field. */
  partial_count: number;
  /** Record ids (canonical) for partial rows — for repair planning. */
  partial_record_ids: string[];
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

export function analyzeCoverage(
  spec: DatasetSpec,
  records: ExtractedRecord[],
): CoverageReport {
  const requiredColumns = spec.columns.filter((col) => col.required);

  const fieldGaps: FieldGap[] = requiredColumns
    .map((col) => {
      const missingRecords = records.filter((record) =>
        isEmpty(record.row[col.name]),
      );

      return {
        column: col.name,
        description: col.description,
        missing_count: missingRecords.length,
        missing_pct:
          records.length > 0 ? missingRecords.length / records.length : 1,
        example_rows: missingRecords.slice(0, 5).map((record) => record.row),
      };
    })
    .filter((gap) => gap.missing_count > 0 || records.length === 0);

  const shouldRepair =
    fieldGaps.length > 0 &&
    (records.length === 0 || fieldGaps.some((gap) => gap.missing_count > 0));

  const partialRecordIds: string[] = [];
  let completeCount = 0;

  for (const record of records) {
    const missingRequired = requiredColumns.some((col) =>
      isEmpty(record.row[col.name]),
    );
    if (missingRequired) {
      const id = canonicalRecordId(record, spec);
      if (id) partialRecordIds.push(id);
    } else {
      completeCount += 1;
    }
  }

  return {
    total_records: records.length,
    required_columns: requiredColumns.map((col) => col.name),
    field_gaps: fieldGaps,
    should_repair: shouldRepair,
    complete_count: completeCount,
    partial_count: partialRecordIds.length,
    partial_record_ids: partialRecordIds,
  };
}

export function countFilledGaps(
  spec: DatasetSpec,
  before: ExtractedRecord[],
  after: ExtractedRecord[],
  columns: string[],
): Record<string, number> {
  const filled = Object.fromEntries(columns.map((col) => [col, 0])) as Record<
    string,
    number
  >;

  const afterByKey = new Map<string, ExtractedRecord>();
  for (const record of after) {
    const key = canonicalRecordId(record, spec);
    if (key && !afterByKey.has(key)) {
      afterByKey.set(key, record);
    }
  }

  for (const prev of before) {
    const key = canonicalRecordId(prev, spec);
    if (!key) continue;
    const next = afterByKey.get(key);
    if (!next) continue;

    for (const column of columns) {
      if (isEmpty(prev.row[column]) && !isEmpty(next.row[column])) {
        filled[column] = (filled[column] ?? 0) + 1;
      }
    }
  }

  return filled;
}
