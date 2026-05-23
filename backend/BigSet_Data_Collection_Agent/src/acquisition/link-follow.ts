import type { FetchedPage } from "../models/schemas.js";
import type { WorkflowMemory } from "../memory/types.js";
import { domainMemoryBoost } from "../memory/workflow-memory.js";
import { getDomain, normalizeUrl } from "../utils/url.js";

const SKIP_HOST =
  /(?:facebook|twitter|x\.com|instagram|youtube|tiktok|pinterest|reddit\.com\/r\/|linkedin\.com\/in\/|accounts\.google|login|signin|signup|register|cookie|privacy|terms|cdn\.|static\.|fonts\.)/i;
const SKIP_EXT = /\.(?:pdf|zip|png|jpe?g|gif|svg|webp|css|js|woff2?|xml|mp4|mp3)(?:\?|$)/i;
const POSITIVE_PATH =
  /\/(?:blog|news|docs|documentation|pricing|billing|investor|investors|earnings|financial|reports|press|release|releases|mcp|model-context-protocol|agents|company|companies|startup|startups|portfolio|team|about|careers|jobs|directory|list|batch|founder|org|organization|profile|detail|view)(?:\/|$|\?)/i;
const NEGATIVE_PATH =
  /\/(?:tag|tags|category|categories|author|feed|rss|search|wp-admin|wp-content)(?:\/|$|\?)/i;

export interface LinkFollowOptions {
  pages: FetchedPage[];
  excludeUrls: Set<string>;
  focusFields?: string[];
  maxTotal: number;
  maxPerSource: number;
  memory?: WorkflowMemory;
}

function pathTokensFromFields(fields?: string[]): string[] {
  if (!fields?.length) return [];
  return fields
    .flatMap((field) =>
      field
        .split(/[_\s-]+/)
        .map((part) => part.toLowerCase())
        .filter((part) => part.length > 3),
    )
    .slice(0, 12);
}

function scoreLink(
  link: string,
  sourceDomain: string,
  focusTokens: string[],
  memory?: WorkflowMemory,
): number {
  let score = 0;

  try {
    const parsed = new URL(link);
    const host = parsed.hostname.toLowerCase();
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();

    if (SKIP_HOST.test(host) || SKIP_EXT.test(path)) return -1000;
    if (NEGATIVE_PATH.test(path)) score -= 2;
    if (POSITIVE_PATH.test(path)) score += 4;

    const linkDomain = getDomain(link);
    if (linkDomain === sourceDomain) score += 3;
    else if (linkDomain.endsWith(`.${sourceDomain}`) || sourceDomain.endsWith(`.${linkDomain}`)) {
      score += 2;
    }

    for (const token of focusTokens) {
      if (path.includes(token)) score += 2;
    }

    if (memory) score += domainMemoryBoost(memory, linkDomain);

    if (path.length > 120) score -= 1;
    if (parsed.hash.length > 1) score -= 1;
  } catch {
    return -1000;
  }

  return score;
}

/** Pick outbound links from high-value pages using URL heuristics only. */
export function selectOutboundLinksToFollow(
  options: LinkFollowOptions,
): string[] {
  const focusTokens = pathTokensFromFields(options.focusFields);
  const selected: string[] = [];
  const selectedSet = new Set<string>();

  const pagesWithLinks = options.pages
    .filter((page) => !page.error && page.outbound_links && page.outbound_links.length > 0)
    .sort((a, b) => (b.outbound_links?.length ?? 0) - (a.outbound_links?.length ?? 0));

  for (const page of pagesWithLinks) {
    const sourceUrl = normalizeUrl(page.final_url || page.url);
    const sourceDomain = getDomain(sourceUrl);
    let perSource = 0;

    const ranked = [...(page.outbound_links ?? [])]
      .map((link) => ({
        link,
        score: scoreLink(link, sourceDomain, focusTokens, options.memory),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const { link } of ranked) {
      if (selected.length >= options.maxTotal) return selected;
      if (perSource >= options.maxPerSource) break;

      const normalized = normalizeUrl(link);
      if (options.excludeUrls.has(normalized)) continue;
      if (selectedSet.has(normalized)) continue;
      if (normalized === sourceUrl) continue;

      selectedSet.add(normalized);
      selected.push(link);
      perSource += 1;
    }
  }

  return selected;
}
