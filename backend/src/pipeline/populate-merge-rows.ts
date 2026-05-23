import type { PopulateExtractionSpec } from "./populate-extraction-spec.js";
import type { PopulateCandidateRow, PopulateRuntimeRow } from "./populate-row.js";
import { normalizePrimaryKey } from "./populate-extract-records.js";
import { uniqueHttpUrls } from "./populate-url-utils.js";

export { normalizePrimaryKey } from "./populate-extract-records.js";

function evidenceQualityScore(row: PopulateCandidateRow): number {
  const evidenceScore = row.evidence.length > 0 ? 1 : 0;
  return row.extractionConfidence * 0.6 + evidenceScore * 0.4;
}

function prefersIncomingRow(
  existing: PopulateCandidateRow,
  incoming: PopulateCandidateRow
): boolean {
  const existingScore = evidenceQualityScore(existing);
  const incomingScore = evidenceQualityScore(incoming);
  if (incomingScore !== existingScore) {
    return incomingScore > existingScore;
  }
  return incoming.sourceUrls.length > existing.sourceUrls.length;
}

function mergeCandidatePair(
  existing: PopulateCandidateRow,
  incoming: PopulateCandidateRow,
  spec: PopulateExtractionSpec
): PopulateCandidateRow {
  const cells = { ...existing.cells };
  const preferIncoming = prefersIncomingRow(existing, incoming);

  for (const column of spec.columns) {
    const current = cells[column.name];
    const next = incoming.cells[column.name];
    const currentEmpty =
      current === null || current === undefined || current === "";
    const nextFilled = !(next === null || next === undefined || next === "");

    if (currentEmpty && nextFilled) {
      cells[column.name] = next;
    } else if (nextFilled && preferIncoming) {
      cells[column.name] = next;
    }
  }

  const sourceUrls = uniqueHttpUrls([
    ...existing.sourceUrls,
    ...incoming.sourceUrls,
  ]);
  const evidence = preferIncoming
    ? [...incoming.evidence, ...existing.evidence]
    : [...existing.evidence, ...incoming.evidence];
  const dedupedEvidence = dedupeEvidence(evidence);

  return {
    cells,
    sourceUrls,
    evidence: dedupedEvidence,
    needsReview: existing.needsReview || incoming.needsReview,
    extractionConfidence: Math.max(
      existing.extractionConfidence,
      incoming.extractionConfidence
    ),
    primaryKey:
      existing.primaryKey ||
      incoming.primaryKey ||
      normalizePrimaryKey(cells[spec.primary_key], spec.primary_key),
  };
}

function dedupeEvidence(
  evidence: PopulateRuntimeRow["evidence"]
): PopulateRuntimeRow["evidence"] {
  const seen = new Set<string>();
  const unique: PopulateRuntimeRow["evidence"] = [];
  for (const item of evidence) {
    const key = `${item.columnName}::${item.sourceUrl}::${item.quote}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export function canonicalRowId(
  row: PopulateCandidateRow,
  spec: PopulateExtractionSpec
): string | null {
  const primary =
    row.primaryKey || normalizePrimaryKey(row.cells[spec.primary_key], spec.primary_key);
  if (primary) {
    return `pk:${primary}`;
  }
  const composite = spec.dedupe_keys
    .map((key) => normalizePrimaryKey(row.cells[key], key))
    .join("||");
  if (composite.replace(/\|/g, "").trim()) {
    return `dk:${composite}`;
  }
  return null;
}

export function mergePopulateCandidateRows(input: {
  spec: PopulateExtractionSpec;
  rows: PopulateCandidateRow[];
  maxRows: number;
}): { rows: PopulateRuntimeRow[]; unkeyed: PopulateRuntimeRow[] } {
  const seen = new Map<string, PopulateCandidateRow>();
  const unkeyed: PopulateCandidateRow[] = [];

  for (const row of input.rows) {
    const id = canonicalRowId(row, input.spec);
    if (!id) {
      unkeyed.push(row);
      continue;
    }
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, row);
      continue;
    }
    seen.set(id, mergeCandidatePair(existing, row, input.spec));
  }

  const merged = [...seen.values(), ...unkeyed]
    .sort((a, b) => evidenceQualityScore(b) - evidenceQualityScore(a))
    .slice(0, input.maxRows)
    .map(toRuntimeRow);

  return { rows: merged, unkeyed: unkeyed.map(toRuntimeRow) };
}

function toRuntimeRow(row: PopulateCandidateRow): PopulateRuntimeRow {
  return {
    cells: row.cells,
    sourceUrls: row.sourceUrls,
    evidence: row.evidence,
    needsReview: row.needsReview,
  };
}
