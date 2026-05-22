import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isUrlLikeColumnName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "url" || lower.endsWith("_url") || lower.includes("url");
}

export function deriveRecordSourceUrls(input: {
  spec: DatasetSpec;
  row: ExtractedRecord["row"];
  evidence: ExtractedRecord["evidence"];
  fallbackUrls?: string[];
}): string[] {
  const urls = new Set<string>();
  for (const item of input.evidence) {
    if (isHttpUrl(item.url)) {
      urls.add(item.url.trim());
    }
  }

  for (const column of input.spec.columns) {
    if (!isUrlLikeColumnName(column.name)) continue;
    const value = input.row[column.name];
    if (isHttpUrl(value)) {
      urls.add(value.trim());
    }
  }

  for (const url of input.fallbackUrls ?? []) {
    if (isHttpUrl(url)) {
      urls.add(url.trim());
    }
  }

  return [...urls];
}

export function scoreDocsUrlForOfficialSource(value: unknown): number {
  if (!isHttpUrl(value)) return 0;
  const normalized = value.toLowerCase();
  let score = 1;
  if (/^https:\/\/(?:docs|developers)\./.test(normalized)) score += 4;
  if (/\/(?:docs|documentation|guides|api\/docs|agents|model-context-protocol|mcp)(?:\/|$|\?)/.test(normalized)) {
    score += 3;
  }
  if (/\b(?:blog|news|course|academy|directory|skilljar)\b/.test(normalized)) {
    score -= 4;
  }
  return score;
}
