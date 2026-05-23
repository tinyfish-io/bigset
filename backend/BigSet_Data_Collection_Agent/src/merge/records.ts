import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";
import {
  deriveRecordSourceUrls,
  isUrlLikeColumnName,
  scoreDocsUrlForOfficialSource,
  scoreUrlForCanonicalSource,
} from "../records/source-urls.js";

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function normalizeComparableValue(value: unknown): string {
  return normalizeValue(value)
    .replace(/https?:\/\/(?:www\.)?/g, "")
    .replace(/[/#?]+$/g, "")
    .replace(/\s+/g, " ");
}

function valuesMatch(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return normalizeComparableValue(a) === normalizeComparableValue(b);
}

/** Normalize entity names for stable primary-key matching. */
export function normalizePrimaryKey(value: unknown): string {
  return normalizeValue(value)
    .replace(
      /\b(?:incorporated|inc|corporation|corp|company|co|llc|ltd|limited|plc)\b\.?$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[''`]/g, "'");
}

export function recordDedupeKey(
  record: ExtractedRecord,
  keys: string[],
): string {
  return keys.map((key) => normalizeValue(record.row[key])).join("||");
}

function isEmptyCompositeKey(key: string, keyCount: number): boolean {
  return !key || key === Array.from({ length: keyCount }, () => "").join("||");
}

/**
 * Primary identity column: first dedupe key, or first column whose name suggests a name/title.
 */
export function getPrimaryKeyColumn(spec: DatasetSpec): string | null {
  if (spec.dedupe_keys.length > 0) {
    return spec.dedupe_keys[0]!;
  }

  const nameLike = spec.columns.find((col) =>
    /(name|title|company|organization|entity)/i.test(col.name),
  );
  return nameLike?.name ?? spec.columns[0]?.name ?? null;
}

export function getPrimaryKeyValue(
  record: ExtractedRecord,
  spec: DatasetSpec,
): string {
  const column = getPrimaryKeyColumn(spec);
  if (!column) return "";
  return normalizePrimaryKey(record.row[column]);
}

/**
 * Canonical row id: primary key when present, otherwise full composite dedupe key.
 */
export function canonicalRecordId(
  record: ExtractedRecord,
  spec: DatasetSpec,
): string | null {
  const primary = getPrimaryKeyValue(record, spec);
  if (primary) {
    return `pk:${primary}`;
  }

  const composite = recordDedupeKey(record, spec.dedupe_keys);
  if (!isEmptyCompositeKey(composite, spec.dedupe_keys.length)) {
    return `dk:${composite}`;
  }

  return null;
}

export interface MergeResult {
  records: ExtractedRecord[];
  unkeyed: ExtractedRecord[];
}

export function mergeRecords(
  spec: DatasetSpec,
  records: ExtractedRecord[],
): MergeResult {
  const seen = new Map<string, ExtractedRecord>();
  const unkeyed: ExtractedRecord[] = [];

  for (const record of records) {
    const id = canonicalRecordId(record, spec);
    if (!id) {
      unkeyed.push(record);
      continue;
    }

    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, record);
      continue;
    }

    seen.set(id, mergePair(existing, record, spec));
  }

  return { records: [...seen.values()], unkeyed };
}

/**
 * Merge repair-pass rows into an existing dataset.
 * Rows with the same primary key (e.g. restaurant name) update in place; new keys add rows.
 */
export function mergeRepairIntoExisting(
  spec: DatasetSpec,
  existing: ExtractedRecord[],
  repairRecords: ExtractedRecord[],
): MergeResult {
  return mergeRecords(spec, [...existing, ...repairRecords]);
}

export function mergePair(
  a: ExtractedRecord,
  b: ExtractedRecord,
  spec: DatasetSpec,
): ExtractedRecord {
  const row: Record<string, string | number | boolean | null> = { ...a.row };
  const fieldsFilledFromIncoming = new Set<string>();
  const shouldPreferIncomingCanonicalRecord = prefersIncomingCanonicalRecord(
    a,
    b,
    spec,
  );
  let replacedCanonicalUrlFromIncoming = false;

  for (const col of spec.columns) {
    const current = row[col.name];
    const incoming = b.row[col.name];
    const currentEmpty = isEmpty(current);
    const incomingFilled = !isEmpty(incoming);

    if (currentEmpty && incomingFilled) {
      row[col.name] = incoming ?? null;
      fieldsFilledFromIncoming.add(col.name);
    } else if (
      incomingFilled &&
      shouldPreferIncomingCanonicalRecord &&
      !spec.dedupe_keys.includes(col.name)
    ) {
      row[col.name] = incoming ?? null;
      fieldsFilledFromIncoming.add(col.name);
      replacedCanonicalUrlFromIncoming ||= isCanonicalSourceUrlColumn(col.name);
    } else if (incomingFilled && shouldReplaceCell(col.name, current, incoming)) {
      row[col.name] = incoming ?? null;
      fieldsFilledFromIncoming.add(col.name);
      replacedCanonicalUrlFromIncoming ||= isCanonicalSourceUrlColumn(col.name);
    }
  }

  if (replacedCanonicalUrlFromIncoming) {
    for (const col of spec.columns) {
      const incoming = b.row[col.name];
      if (
        shouldReplaceCompanionColumn(col.name, spec) &&
        !isEmpty(incoming) &&
        !spec.dedupe_keys.includes(col.name)
      ) {
        row[col.name] = incoming ?? null;
        fieldsFilledFromIncoming.add(col.name);
      }
    }
  }

  const evidence = a.evidence.filter((item) =>
    valuesMatch(row[item.field], a.row[item.field]),
  );
  const evidenceFields = new Set(evidence.map((e) => e.field));
  for (const item of b.evidence) {
    if (
      !evidenceFields.has(item.field) &&
      shouldMergeIncomingEvidence({
        field: item.field,
        mergedRow: row,
        incomingRow: b.row,
        fieldsFilledFromIncoming,
      })
    ) {
      evidence.push(item);
      evidenceFields.add(item.field);
    }
  }
  const coherentEvidence = filterEvidenceForRetainedCanonicalUrl(spec, row, evidence);

  const extractionConfidence = Math.max(
    a.extraction_confidence ?? 0,
    b.extraction_confidence ?? 0,
  );

  return {
    row,
    evidence: coherentEvidence,
    source_urls: deriveRecordSourceUrls({
      spec,
      row,
      evidence: coherentEvidence,
      fallbackUrls: coherentEvidence.length > 0 ? [] : a.source_urls,
    }),
    ...(extractionConfidence > 0
      ? { extraction_confidence: extractionConfidence }
      : {}),
  };
}

function shouldMergeIncomingEvidence(input: {
  field: string;
  mergedRow: Record<string, string | number | boolean | null>;
  incomingRow: Record<string, string | number | boolean | null>;
  fieldsFilledFromIncoming: Set<string>;
}): boolean {
  if (
    isCanonicalSourceUrlColumn(input.field) &&
    !urlsReferenceSamePage(
      input.incomingRow[input.field],
      input.mergedRow[input.field],
    )
  ) {
    return false;
  }
  if (input.fieldsFilledFromIncoming.has(input.field)) {
    return true;
  }
  return valuesMatch(input.mergedRow[input.field], input.incomingRow[input.field]);
}

function shouldReplaceCell(
  columnName: string,
  current: string | number | boolean | null | undefined,
  incoming: string | number | boolean | null | undefined,
): boolean {
  if (!isCanonicalSourceUrlColumn(columnName)) {
    return false;
  }
  return (
    scoreUrlForCanonicalSource(incoming) > scoreUrlForCanonicalSource(current)
  );
}

function prefersIncomingCanonicalRecord(
  current: ExtractedRecord,
  incoming: ExtractedRecord,
  spec: DatasetSpec,
): boolean {
  const currentScore = bestCanonicalScore(current, spec);
  const incomingScore = bestCanonicalScore(incoming, spec);
  if (incomingScore > currentScore) {
    return true;
  }
  if (incomingScore < currentScore) {
    return false;
  }

  const currentDate = bestRecordTimestamp(current, spec);
  const incomingDate = bestRecordTimestamp(incoming, spec);
  return incomingDate !== null && currentDate !== null && incomingDate > currentDate;
}

function bestCanonicalScore(record: ExtractedRecord, spec: DatasetSpec): number {
  let bestScore = 0;
  for (const column of spec.columns) {
    if (!isCanonicalSourceUrlColumn(column.name)) continue;
    bestScore = Math.max(
      bestScore,
      scoreUrlForCanonicalSource(record.row[column.name]),
    );
  }
  return bestScore;
}

function bestRecordTimestamp(
  record: ExtractedRecord,
  spec: DatasetSpec,
): number | null {
  const timestamps = spec.columns
    .filter((column) => column.name.toLowerCase().includes("date"))
    .map((column) => Date.parse(String(record.row[column.name] ?? "")))
    .filter(Number.isFinite);
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(...timestamps);
}

function isDocsUrlColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  return (
    lower === "docs_url" ||
    lower.endsWith("_docs_url") ||
    (lower.includes("docs") && lower.includes("url"))
  );
}

function isDocsCompanionColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  return (
    lower === "summary" ||
    lower === "description" ||
    lower === "docs_title" ||
    (lower.includes("docs") && lower.includes("title"))
  );
}

function isCanonicalSourceUrlColumn(columnName: string): boolean {
  return isUrlLikeColumnName(columnName);
}

function shouldReplaceCompanionColumn(
  columnName: string,
  spec: DatasetSpec,
): boolean {
  if (spec.dedupe_keys.includes(columnName)) {
    return false;
  }
  return !isCanonicalSourceUrlColumn(columnName);
}

function filterEvidenceForRetainedCanonicalUrl(
  spec: DatasetSpec,
  row: Record<string, string | number | boolean | null>,
  evidence: ExtractedRecord["evidence"],
): ExtractedRecord["evidence"] {
  const retainedUrl = bestRetainedCanonicalUrl(spec, row);
  if (!retainedUrl) {
    return evidence;
  }

  return evidence.filter((item) => {
    if (isCanonicalSourceUrlColumn(item.field)) {
      return urlsReferenceSamePage(item.url, row[item.field]);
    }

    if (
      isDocsCompanionColumn(item.field) ||
      isLikelySourceCompanionColumn(item.field) ||
      spec.dedupe_keys.includes(item.field)
    ) {
      return sourceUrlSupportsRetainedCanonicalUrl(item.url, retainedUrl);
    }

    return true;
  });
}

function bestRetainedCanonicalUrl(
  spec: DatasetSpec,
  row: Record<string, string | number | boolean | null>,
): string | null {
  let bestUrl: string | null = null;
  let bestScore = 0;
  for (const col of spec.columns) {
    if (!isCanonicalSourceUrlColumn(col.name)) continue;
    const value = row[col.name];
    const score = scoreUrlForCanonicalSource(value);
    if (typeof value === "string" && score > bestScore) {
      bestUrl = value;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? bestUrl : null;
}

function isLikelySourceCompanionColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  return (
    lower.includes("date") ||
    lower.includes("quarter") ||
    lower.includes("price") ||
    lower.includes("plan") ||
    lower.includes("title") ||
    lower.includes("summary") ||
    lower.includes("description")
  );
}

function sourceUrlSupportsRetainedCanonicalUrl(
  evidenceUrl: unknown,
  retainedUrl: string,
): boolean {
  if (urlsReferenceSamePage(evidenceUrl, retainedUrl)) {
    return true;
  }
  if (scoreDocsUrlForOfficialSource(retainedUrl) < 4) {
    return false;
  }
  return (
    sameHostname(evidenceUrl, retainedUrl) &&
    scoreUrlForCanonicalSource(evidenceUrl) >= 2
  );
}

function urlsReferenceSamePage(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return normalizeComparableValue(a) === normalizeComparableValue(b);
}

function sameHostname(a: unknown, b: unknown): boolean {
  try {
    const aHost = new URL(String(a)).hostname.replace(/^www\./, "");
    const bHost = new URL(String(b)).hostname.replace(/^www\./, "");
    return aHost === bHost;
  } catch {
    return false;
  }
}
