import type { DatasetContext } from "./populate.js";
import type {
  PopulateFetchedPage,
  PopulateRuntimeRow,
  PopulateWebSearchResult,
} from "./populate-runtime.js";

export type PopulateSourceTriageStatus =
  | "extract_now"
  | "requires_navigation"
  | "requires_form_submission"
  | "requires_detail_page_followup"
  | "blocked"
  | "irrelevant"
  | "low_value";

export interface PopulateRankedSearchResult extends PopulateWebSearchResult {
  canonicalUrl: string;
  expectationScore: number;
  lowTrustReason?: string;
}

export interface PopulateSourceTriageResult {
  status: PopulateSourceTriageStatus;
  confidence: number;
  reason: string;
  suggestedAction?: string;
}

const LOW_TRUST_HOST_PATTERNS = [
  /(^|\.)reddit\.com$/i,
  /(^|\.)quora\.com$/i,
  /(^|\.)medium\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
];

const SOURCE_PLANNER_FETCH_LIMIT_DEFAULT = 8;

export function canonicalPopulateSourceUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

export function rankPopulateSearchResults(input: {
  context: DatasetContext;
  results: PopulateWebSearchResult[];
}): PopulateRankedSearchResult[] {
  const byCanonicalUrl = new Map<string, PopulateRankedSearchResult>();
  for (const result of input.results) {
    const canonicalUrl = canonicalPopulateSourceUrl(result.url);
    const ranked = {
      ...result,
      canonicalUrl,
      ...scorePopulateSearchResult({
        context: input.context,
        result: { ...result, url: canonicalUrl },
      }),
    };
    const existing = byCanonicalUrl.get(canonicalUrl);
    if (!existing || ranked.expectationScore > existing.expectationScore) {
      byCanonicalUrl.set(canonicalUrl, ranked);
    }
  }

  return [...byCanonicalUrl.values()].sort((left, right) => {
    if (right.expectationScore !== left.expectationScore) {
      return right.expectationScore - left.expectationScore;
    }
    return left.canonicalUrl.localeCompare(right.canonicalUrl);
  });
}

export function buildPopulateFetchPlan(input: {
  rankedResults: PopulateRankedSearchResult[];
  fetchLimit?: number;
}): string[] {
  return input.rankedResults
    .slice(0, input.fetchLimit ?? SOURCE_PLANNER_FETCH_LIMIT_DEFAULT)
    .map((result) => result.canonicalUrl);
}

export function triageFetchedPageForPopulate(input: {
  context: DatasetContext;
  url: string;
  page: PopulateFetchedPage;
}): PopulateSourceTriageResult {
  const text = [input.page.title, input.page.text].filter(Boolean).join("\n");
  const normalizedText = text.toLowerCase();
  const normalizedUrl = input.url.toLowerCase();

  if (isBlockedPageText(normalizedText)) {
    return {
      status: "blocked",
      confidence: 0.9,
      reason: "Page appears blocked by auth, captcha, access control, or anti-bot copy.",
      suggestedAction: "Use browser diagnostics only if the data is publicly accessible.",
    };
  }

  if (/\b(search|filter|location|zipcode|zip code|enter your|select)\b/i.test(text)) {
    return {
      status: /submit|form|zipcode|zip code|enter your/i.test(text)
        ? "requires_form_submission"
        : "requires_navigation",
      confidence: 0.75,
      reason: "Page likely requires browser interaction before the requested rows are visible.",
      suggestedAction: "Navigate the page, apply required filters, then extract source-backed rows.",
    };
  }

  if (/\/search|\/locator|\/directory|\/catalog|\/companies|\/jobs/i.test(normalizedUrl)) {
    return {
      status: "requires_detail_page_followup",
      confidence: 0.7,
      reason: "URL looks like a listing or directory that may need detail-page follow-up.",
      suggestedAction: "Open relevant detail pages and extract requested fields from those public pages.",
    };
  }

  const relevantTokenCount = relevantPlannerTokens(input.context)
    .filter((token) => normalizedText.includes(token)).length;
  if (relevantTokenCount === 0 && normalizedText.length > 0) {
    return {
      status: "low_value",
      confidence: 0.65,
      reason: "Fetched text has little overlap with the dataset prompt or columns.",
    };
  }

  if (normalizedText.length < 200) {
    return {
      status: "low_value",
      confidence: 0.6,
      reason: "Fetched text is too short to support source-backed rows.",
    };
  }

  return {
    status: "extract_now",
    confidence: Math.min(0.95, 0.55 + relevantTokenCount * 0.08),
    reason: "Fetched text appears to contain enough inline public data to attempt extraction before browser spend.",
  };
}

export function directRowsFromFetchedPage(input: {
  context: DatasetContext;
  url: string;
  page: PopulateFetchedPage;
  maxRows?: number;
}): PopulateRuntimeRow[] {
  const titleColumn = input.context.columns.find((column) =>
    /title|name/i.test(column.name)
  );
  const urlColumn = input.context.columns.find((column) =>
    /url|link|website|source/i.test(column.name)
  );
  if (!titleColumn || !urlColumn) {
    return [];
  }

  const requiredColumns = input.context.columns.filter(
    (column) => column.nullable !== true
  );
  if (
    requiredColumns.some((column) =>
      column.name !== titleColumn.name && column.name !== urlColumn.name
    )
  ) {
    return [];
  }

  const title = firstUsefulLine([input.page.title, input.page.text].filter(Boolean).join("\n"));
  if (!title) {
    return [];
  }

  const cells = Object.fromEntries(
    input.context.columns.map((column) => {
      if (column.name === titleColumn.name) {
        return [column.name, title];
      }
      if (column.name === urlColumn.name) {
        return [column.name, input.url];
      }
      return [column.name, null];
    })
  );

  return [{
    cells,
    sourceUrls: [input.url],
    evidence: [{
      columnName: titleColumn.name,
      sourceUrl: input.url,
      quote: title,
    }],
    needsReview: true,
  }].slice(0, input.maxRows ?? 1);
}

function scorePopulateSearchResult(input: {
  context: DatasetContext;
  result: PopulateWebSearchResult;
}): Pick<PopulateRankedSearchResult, "expectationScore" | "lowTrustReason"> {
  const lowTrustReason = lowTrustSourceReason(input.result.url);
  if (lowTrustReason) {
    return { expectationScore: 1, lowTrustReason };
  }

  const haystack = [
    input.result.title,
    input.result.snippet,
    input.result.url,
  ].filter(Boolean).join(" ").toLowerCase();
  let score = 2;
  if ((input.result.snippet?.length ?? 0) >= 40) score += 1;
  if (/\b(official|docs|documentation|pricing|blog|news|release|careers|jobs)\b/.test(haystack)) {
    score += 1;
  }
  if (plannerHostLooksPrimary(input.result.url)) {
    score += 0.5;
  }
  const overlap = relevantPlannerTokens(input.context)
    .filter((token) => haystack.includes(token)).length;
  score += Math.min(1.5, overlap * 0.3);

  return {
    expectationScore: Math.max(1, Math.min(5, Math.round(score * 10) / 10)),
  };
}

function lowTrustSourceReason(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return LOW_TRUST_HOST_PATTERNS.some((pattern) => pattern.test(host))
      ? `low-trust host: ${host}`
      : undefined;
  } catch {
    return "invalid URL";
  }
}

function plannerHostLooksPrimary(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /\.(com|org|io|ai|dev|gov|edu)$/i.test(host);
  } catch {
    return false;
  }
}

function relevantPlannerTokens(context: DatasetContext): string[] {
  return Array.from(new Set([
    userPromptDescription(context.description),
    ...context.columns.map((column) => `${column.name} ${column.description ?? ""}`),
  ]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) =>
      token.length >= 4 &&
      ![
        "with",
        "from",
        "that",
        "this",
        "have",
        "source",
        "sources",
        "column",
        "columns",
        "include",
        "latest",
      "find",
    ].includes(token)
    )));
}

function userPromptDescription(description: string): string {
  return description
    .split(/\n\s*Durable recipe instructions:\s*/i)[0]
    ?.trim() || description.trim();
}

function isBlockedPageText(text: string): boolean {
  return /\b(captcha|access denied|forbidden|sign in to continue|enable javascript|unusual traffic|verify you are human)\b/i.test(text);
}

function firstUsefulLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) =>
      line.length >= 8 &&
      line.length <= 200 &&
      !/^https?:\/\//i.test(line)
    ) ?? "";
}
