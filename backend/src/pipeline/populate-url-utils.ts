/** True when value is a non-empty http(s) URL string. */
export function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** Coerces LLM/tool output into a single http(s) URL, or null when not URL-like. */
export function coerceHttpUrl(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const coerced = coerceHttpUrl(item);
      if (coerced) {
        return coerced;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["url", "href", "link"] as const) {
      const coerced = coerceHttpUrl(record[key]);
      if (coerced) {
        return coerced;
      }
    }
  }
  return null;
}

export function uniqueHttpUrls(urls: unknown[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const coerced = coerceHttpUrl(url);
    if (!coerced || seen.has(coerced)) {
      continue;
    }
    seen.add(coerced);
    unique.push(coerced);
  }
  return unique;
}
