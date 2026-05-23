import { canonicalRecordId } from "../merge/records.js";
import type { RecordQuality } from "../models/quality.js";
import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** Row has every required column populated. */
export function hasAllRequiredFields(
  spec: DatasetSpec,
  record: ExtractedRecord,
): boolean {
  return spec.columns
    .filter((col) => col.required)
    .every((col) => !isEmpty(record.row[col.name]));
}

/**
 * Records for the primary results view: all required fields present,
 * ranked by completeness (desc) then confidence (desc).
 */
export function selectVisualizationRecords(
  spec: DatasetSpec,
  records: ExtractedRecord[],
  qualityById: Map<string, RecordQuality>,
): ExtractedRecord[] {
  const eligible = records.filter((record) => {
    if (!hasAllRequiredFields(spec, record)) return false;
    const id = canonicalRecordId(record, spec);
    if (!id) return false;
    const quality = qualityById.get(id);
    return quality !== undefined && quality.missing_required_fields.length === 0;
  });

  return eligible.sort((a, b) => {
    const idA = canonicalRecordId(a, spec)!;
    const idB = canonicalRecordId(b, spec)!;
    const qA = qualityById.get(idA)!;
    const qB = qualityById.get(idB)!;

    if (qB.completeness_pct !== qA.completeness_pct) {
      return qB.completeness_pct - qA.completeness_pct;
    }
    return qB.confidence_score - qA.confidence_score;
  });
}
