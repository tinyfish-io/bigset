import { selectOutboundLinksToFollow } from "../acquisition/link-follow.js";
import { config } from "../config.js";
import { chunkUrls, fetchPages, searchWeb } from "../integrations/tinyfish.js";
import { domainMemoryBoost, type WorkflowMemory } from "../memory/index.js";
import type { SearchPlan } from "../memory/search-pagination.js";
import { getPrimaryKeyValue } from "../merge/records.js";
import { createFetchQueue, createSearchQueue } from "../queue/pools.js";
import type {
  AgentRunRecord,
  DatasetSpec,
  ExtractedRecord,
  FetchedPage,
  SourceCandidate,
  SourceTriageResult,
  TriageSummary,
} from "../models/schemas.js";
import { saveFetchedPage, type RunPaths } from "../storage/run-store.js";
import {
  processFetchedPages,
  type AgentDeferredEntry,
} from "./process-pages.js";
import { getDomain, normalizeUrl } from "../utils/url.js";

export interface AcquisitionResult {
  candidates: SourceCandidate[];
  fetchedUrls: string[];
  failedUrls: string[];
  fetchedPages: FetchedPage[];
  records: ExtractedRecord[];
  pagesFetched: number;
  triage: TriageSummary;
  triageResults: SourceTriageResult[];
  agentRuns: AgentRunRecord[];
  agentDeferred: AgentDeferredEntry[];
}

function rankCandidates(
  candidates: SourceCandidate[],
  excludeUrls: Set<string>,
  limit: number,
  memory?: WorkflowMemory,
): string[] {
  const byUrl = new Map<
    string,
    { url: string; score: number; domain: string }
  >();

  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    if (excludeUrls.has(url)) continue;

    const domain = getDomain(url);
    let score = byUrl.get(url)?.score ?? 0;
    score += 1;
    if (candidate.title.length > 10) score += 0.5;
    if (candidate.snippet.length > 40) score += 0.5;
    if (memory) score += domainMemoryBoost(memory, domain);
    byUrl.set(url, { url, score, domain });
  }

  const domainsSeen = new Set<string>();
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      if (domainsSeen.has(item.domain)) return false;
      domainsSeen.add(item.domain);
      return true;
    })
    .map((item) => item.url)
    .slice(0, limit);
}

export async function runAcquisitionPhase(options: {
  label: string;
  userPrompt: string;
  spec: DatasetSpec;
  queries: string[];
  /** When set, runs Search with per-query page indices (repair pagination). */
  searches?: SearchPlan[];
  paths: RunPaths;
  errors: string[];
  excludeUrls: Set<string>;
  maxResultsPerQuery: number;
  maxUrlsToFetch: number;
  pageIndexStart: number;
  focusFields?: string[];
  knownEntityKeys?: string[];
  enableTriage?: boolean;
  enableTinyfishAgent?: boolean;
  agentPollTimeoutMs?: number;
  memory?: WorkflowMemory;
  forceAgent?: boolean;
  /** Fetch outbound links from high-value pages (repair). */
  enableLinkFollow?: boolean;
  log: (stage: string, message: string) => void;
}): Promise<AcquisitionResult> {
  const searchQueue = createSearchQueue();
  const fetchQueue = createFetchQueue();

  const searches: SearchPlan[] =
    options.searches ??
    options.queries.map((query) => ({ query, page: 0 }));

  options.log(
    options.label,
    `Running ${searches.length} searches (parallel, concurrency=${config.searchConcurrency})...`,
  );

  const searchBatches = await searchQueue.runAll(
    searches,
    async (plan) => {
      try {
        const results = await searchWeb(plan.query, plan.page);
        return results.slice(0, options.maxResultsPerQuery).map((result) => ({
          ...result,
          query: plan.query,
          search_page: plan.page,
        }));
      } catch (error) {
        const msg = `Search failed for "${plan.query}" (page ${plan.page}): ${
          error instanceof Error ? error.message : String(error)
        }`;
        options.errors.push(msg);
        options.log(options.label, `WARN ${msg}`);
        return [] as SourceCandidate[];
      }
    },
  );
  const candidates: SourceCandidate[] = searchBatches.flat();

  const urlsToFetch = rankCandidates(
    candidates,
    options.excludeUrls,
    options.maxUrlsToFetch,
    options.memory,
  );

  const fetchWithLinks = options.enableLinkFollow ?? false;
  const urlChunks = chunkUrls(urlsToFetch, config.fetchBatchSize);

  options.log(
    options.label,
    `Fetching ${urlsToFetch.length} URLs in ${urlChunks.length} parallel batches (concurrency=${config.fetchConcurrency})${fetchWithLinks ? " with outbound links" : ""}...`,
  );

  const fetchChunk = async (chunk: string[], includeLinks: boolean) => {
    try {
      return await fetchPages(chunk, { includeLinks });
    } catch (error) {
      const msg = `Fetch batch failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      options.errors.push(msg);
      options.log(options.label, `WARN ${msg}`);
      return chunk.map((url) => ({
        url,
        final_url: url,
        title: "",
        text: "",
        error: msg,
      }));
    }
  };

  let fetchedPages: FetchedPage[] =
    urlChunks.length > 0
      ? (
          await fetchQueue.runAll(
            urlChunks,
            (chunk) => fetchChunk(chunk, fetchWithLinks),
            (chunk) => chunk.map((url) => getDomain(url)),
          )
        ).flat()
      : [];

  if (fetchWithLinks && fetchedPages.length > 0) {
    const linkUrls = selectOutboundLinksToFollow({
      pages: fetchedPages,
      excludeUrls: options.excludeUrls,
      focusFields: options.focusFields,
      maxTotal: config.maxRepairLinkUrls,
      maxPerSource: config.maxLinksPerSourcePage,
      memory: options.memory,
    }).filter((url) => !urlsToFetch.includes(normalizeUrl(url)));

    if (linkUrls.length > 0) {
      const linkChunks = chunkUrls(linkUrls, config.fetchBatchSize);
      options.log(
        options.label,
        `Following ${linkUrls.length} high-relevance outbound links...`,
      );
      const linkPages = (
        await fetchQueue.runAll(
          linkChunks,
          (chunk) => fetchChunk(chunk, false),
          (chunk) => chunk.map((url) => getDomain(url)),
        )
      ).flat();
      fetchedPages = [...fetchedPages, ...linkPages];
    }
  }

  let pageIndex = options.pageIndexStart;
  for (const page of fetchedPages) {
    await saveFetchedPage(options.paths, page, pageIndex);
    pageIndex += 1;
  }

  const failedUrls = fetchedPages
    .filter((page) => page.error)
    .map((page) => page.url);

  const processed = await processFetchedPages({
    label: options.label,
    userPrompt: options.userPrompt,
    spec: options.spec,
    pages: fetchedPages,
    paths: options.paths,
    errors: options.errors,
    focusFields: options.focusFields,
    knownEntityKeys: options.knownEntityKeys,
    enableTriage: options.enableTriage,
    enableTinyfishAgent:
      options.enableTinyfishAgent ??
      (options.forceAgent ? true : config.enableTinyfishAgent),
    agentPollTimeoutMs: options.agentPollTimeoutMs,
    memory: options.memory,
    log: options.log,
  });

  const allFetchedUrls = [
    ...new Set([
      ...urlsToFetch.map((url) => normalizeUrl(url)),
      ...fetchedPages.map((page) => normalizeUrl(page.url)),
    ]),
  ];

  return {
    candidates,
    fetchedUrls: allFetchedUrls,
    failedUrls,
    fetchedPages,
    records: processed.records,
    pagesFetched: fetchedPages.length,
    triage: processed.summary,
    triageResults: processed.triageResults,
    agentRuns: processed.agentRuns,
    agentDeferred: processed.agentDeferred,
  };
}

export function entityKeysFromRecords(
  spec: DatasetSpec,
  records: ExtractedRecord[],
): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    const pk = getPrimaryKeyValue(record, spec);
    if (pk) keys.add(pk);
  }
  return [...keys];
}
