import {
  isLowTrustSourceUrl,
} from "./populate-acquisition-prompt.js";
import type { DatasetContext } from "./populate.js";
import type { DatasetSchema } from "./types.js";
import type { AgentSearchScore } from "./types.js";

export type { AgentSearchScore } from "./types.js";

export interface SearchResultForPrioritization {
  title: string;
  snippet?: string;
  url: string;
  site_name?: string;
}

export interface PrioritizedSearchResult extends SearchResultForPrioritization {
  expectation_score: number;
}

/**
 * Finalizes ranked search results: merges acquisition scores, fills gaps with heuristics,
 * sorts by expectation_score descending, dedupes by URL.
 */
export function prioritizeSearchResultsForSchema(input: {
  context: DatasetContext;
  results: SearchResultForPrioritization[];
  agentScores?: AgentSearchScore[];
}): PrioritizedSearchResult[] {
  const merged = mergeAgentScoresIntoResults(
    input.results,
    input.agentScores ?? [],
    input.context
  );

  const byUrl = new Map<string, PrioritizedSearchResult>();
  for (const result of merged) {
    const key = normalizeSearchResultUrl(result.url);
    const existing = byUrl.get(key);
    if (!existing || result.expectation_score > existing.expectation_score) {
      byUrl.set(key, result);
    }
  }

  return [...byUrl.values()].sort((a, b) => {
    if (b.expectation_score !== a.expectation_score) {
      return b.expectation_score - a.expectation_score;
    }
    return a.url.localeCompare(b.url);
  });
}

export function finalizePrioritizedSearchResults(input: {
  context: DatasetContext;
  dataSpec?: DatasetSchema;
  results: SearchResultForPrioritization[];
  agentScores?: AgentSearchScore[];
}): PrioritizedSearchResult[] {
  if (input.results.length === 0) {
    return [];
  }

  return prioritizeSearchResultsForSchema({
    context: input.context,
    results: input.results,
    agentScores: input.agentScores,
  });
}

function mergeAgentScoresIntoResults(
  results: SearchResultForPrioritization[],
  agentScores: AgentSearchScore[],
  context: DatasetContext
): PrioritizedSearchResult[] {
  const scoreByUrl = new Map<string, AgentSearchScore>();
  for (const score of agentScores) {
    scoreByUrl.set(normalizeSearchResultUrl(score.url), score);
  }

  return results.map((result) => {
    const agentScore = scoreByUrl.get(normalizeSearchResultUrl(result.url));
    return {
      ...result,
      expectation_score:
        agentScore?.expectation_score ?? heuristicExpectationScore(result, context),
    };
  });
}

export function selectTopPrioritizedFetchUrls(
  results: PrioritizedSearchResult[],
  fetchLimit: number
): string[] {
  return results
    .slice(0, fetchLimit)
    .map((result) => normalizeSearchResultUrl(result.url));
}

function heuristicExpectationScore(
  result: SearchResultForPrioritization,
  context?: DatasetContext
): number {
  if (isLowTrustSourceUrl(result.url)) {
    return 1;
  }

  const haystack = [
    result.site_name,
    result.title,
    result.snippet,
    result.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 2;
  if ((result.snippet?.length ?? 0) > 40) score += 1;
  if (result.title.length > 10) score += 1;
  if (/\b(official|docs|pricing|blog|news|release)\b/.test(haystack)) score += 1;

  if (context) {
    const keywords = [
      ...context.description.toLowerCase().split(/\W+/),
      ...context.columns.flatMap((column) => [
        column.name,
        column.description ?? "",
      ]),
    ]
      .map((token) => token.trim())
      .filter((token) => token.length > 3);
    if (keywords.some((token) => haystack.includes(token))) {
      score += 1;
    }
  }

  return Math.max(1, Math.min(5, score));
}

export function normalizeSearchResultUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

export function siteNameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
