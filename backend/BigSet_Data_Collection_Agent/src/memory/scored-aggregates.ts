import type {
  AgentRunRecord,
  DatasetSpec,
  ExtractedRecord,
  SourceCandidate,
  SourceTriageResult,
} from "../models/schemas.js";
import { agentExtractedUrls, triageByUrl } from "../quality/index.js";
import { scoreRecord, type ScoreRecordContext } from "../quality/score-record.js";
import { getDomain, normalizeUrl } from "../utils/url.js";
import { recomputeWeightedQuality } from "./search-pagination.js";
import type {
  AgentGoalMemoryEntry,
  DomainMemoryEntry,
  QueryMemoryEntry,
  QueryPageBreakdown,
  WorkflowMemory,
} from "./types.js";

export interface RecordMetrics {
  completeness: number;
  confidence: number;
}

function rollingAvg(current: number, count: number, value: number): number {
  if (count <= 0) return value;
  return (current * count + value) / (count + 1);
}

export function metricsForRecord(
  spec: DatasetSpec,
  record: ExtractedRecord,
  context: ScoreRecordContext,
): RecordMetrics {
  const quality = scoreRecord(spec, record, context, "memory");
  return {
    completeness: quality.completeness_pct,
    confidence: quality.confidence_score,
  };
}

export function buildUrlToQueryMap(
  candidates: SourceCandidate[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const candidate of candidates) {
    map.set(normalizeUrl(candidate.url), candidate.query);
  }
  return map;
}

function getOrCreateQueryEntry(
  memory: WorkflowMemory,
  query: string,
  phase: string,
  repairLoop: number,
): QueryMemoryEntry {
  let entry = memory.query_stats.find(
    (item) => item.query === query && item.phase === phase,
  );
  if (!entry) {
    entry = {
      query,
      phase,
      repair_loop: repairLoop,
      urls_produced: 0,
      urls_with_records: 0,
      record_count: 0,
      avg_completeness: 0,
      avg_confidence: 0,
      search_page: 0,
      weighted_quality: 0,
      page_breakdown: [],
    };
    memory.query_stats.push(entry);
  }
  return entry;
}

function getOrCreatePageSlice(
  entry: QueryMemoryEntry,
  page: number,
): QueryPageBreakdown {
  let slice = entry.page_breakdown.find((item) => item.page === page);
  if (!slice) {
    slice = {
      page,
      urls_produced: 0,
      urls_with_records: 0,
      record_count: 0,
      avg_completeness: 0,
      avg_confidence: 0,
    };
    entry.page_breakdown.push(slice);
  }
  return slice;
}

function applyMetricsToPageSlice(
  slice: QueryPageBreakdown,
  metrics: RecordMetrics,
): void {
  slice.avg_completeness = rollingAvg(
    slice.avg_completeness,
    slice.record_count,
    metrics.completeness,
  );
  slice.avg_confidence = rollingAvg(
    slice.avg_confidence,
    slice.record_count,
    metrics.confidence,
  );
  slice.record_count += 1;
}

function getOrCreateDomainEntry(
  memory: WorkflowMemory,
  domain: string,
  repairLoop: number,
): DomainMemoryEntry {
  let entry = memory.domain_stats.find((item) => item.domain === domain);
  if (!entry) {
    entry = {
      domain,
      record_count: 0,
      fetch_failures: 0,
      avg_completeness: 0,
      avg_confidence: 0,
      last_repair_loop: repairLoop,
    };
    memory.domain_stats.push(entry);
  }
  return entry;
}

function applyMetricsToDomain(
  entry: DomainMemoryEntry,
  metrics: RecordMetrics,
  repairLoop: number,
): void {
  entry.avg_completeness = rollingAvg(
    entry.avg_completeness,
    entry.record_count,
    metrics.completeness,
  );
  entry.avg_confidence = rollingAvg(
    entry.avg_confidence,
    entry.record_count,
    metrics.confidence,
  );
  entry.record_count += 1;
  entry.last_repair_loop = repairLoop;
}

function applyMetricsToQuery(
  entry: QueryMemoryEntry,
  metrics: RecordMetrics,
  searchPage = 0,
): void {
  entry.avg_completeness = rollingAvg(
    entry.avg_completeness,
    entry.record_count,
    metrics.completeness,
  );
  entry.avg_confidence = rollingAvg(
    entry.avg_confidence,
    entry.record_count,
    metrics.confidence,
  );
  entry.record_count += 1;
  entry.search_page = Math.max(entry.search_page ?? 0, searchPage);

  const slice = getOrCreatePageSlice(entry, searchPage);
  applyMetricsToPageSlice(slice, metrics);
  recomputeWeightedQuality(entry);
}

export function attributeRecordsToMemory(options: {
  memory: WorkflowMemory;
  spec: DatasetSpec;
  phase: string;
  repairLoop: number;
  queries: string[];
  candidates: SourceCandidate[];
  records: ExtractedRecord[];
  failedUrls: string[];
  agentRuns: AgentRunRecord[];
  triageResults: SourceTriageResult[];
}): void {
  const {
    memory,
    spec,
    phase,
    repairLoop,
    queries,
    candidates,
    records,
    failedUrls,
    agentRuns,
    triageResults,
  } = options;

  const urlToQuery = buildUrlToQueryMap(candidates);
  const context: ScoreRecordContext = {
    triageByUrl: triageByUrl(triageResults),
    agentExtractedUrls: agentExtractedUrls(agentRuns),
  };

  const candidateUrlsByQuery = new Map<string, Set<string>>();
  const candidateUrlsByQueryPage = new Map<string, Map<number, Set<string>>>();
  const urlToSearchPage = new Map<string, number>();

  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate.url);
    const page = candidate.search_page ?? 0;
    urlToSearchPage.set(normalized, page);

    if (!candidateUrlsByQuery.has(candidate.query)) {
      candidateUrlsByQuery.set(candidate.query, new Set());
    }
    candidateUrlsByQuery.get(candidate.query)!.add(normalized);

    if (!candidateUrlsByQueryPage.has(candidate.query)) {
      candidateUrlsByQueryPage.set(candidate.query, new Map());
    }
    const byPage = candidateUrlsByQueryPage.get(candidate.query)!;
    if (!byPage.has(page)) byPage.set(page, new Set());
    byPage.get(page)!.add(normalized);
  }

  for (const query of queries) {
    const entry = getOrCreateQueryEntry(memory, query, phase, repairLoop);
    const urls = candidateUrlsByQuery.get(query);
    if (urls) entry.urls_produced += urls.size;

    const byPage = candidateUrlsByQueryPage.get(query);
    if (byPage) {
      for (const [page, pageUrls] of byPage) {
        const slice = getOrCreatePageSlice(entry, page);
        slice.urls_produced += pageUrls.size;
        entry.search_page = Math.max(entry.search_page ?? 0, page);
      }
    }
  }

  const urlsWithRecordsByQuery = new Map<string, Set<string>>();
  const urlsWithRecordsByQueryPage = new Map<string, Map<number, Set<string>>>();

  for (const record of records) {
    const metrics = metricsForRecord(spec, record, context);
    const queriesHit = new Set<string>();
    const domainsHit = new Set<string>();

    const attributeUrl = (rawUrl: string) => {
      const normalized = normalizeUrl(rawUrl);
      const domain = getDomain(rawUrl);

      if (!domainsHit.has(domain)) {
        domainsHit.add(domain);
        applyMetricsToDomain(
          getOrCreateDomainEntry(memory, domain, repairLoop),
          metrics,
          repairLoop,
        );
      }

      const query = urlToQuery.get(normalized);
      if (query) {
        if (!urlsWithRecordsByQuery.has(query)) {
          urlsWithRecordsByQuery.set(query, new Set());
        }
        urlsWithRecordsByQuery.get(query)!.add(normalized);
        queriesHit.add(query);

        const page = urlToSearchPage.get(normalized) ?? 0;
        if (!urlsWithRecordsByQueryPage.has(query)) {
          urlsWithRecordsByQueryPage.set(query, new Map());
        }
        const byPage = urlsWithRecordsByQueryPage.get(query)!;
        if (!byPage.has(page)) byPage.set(page, new Set());
        byPage.get(page)!.add(normalized);
      }
    };

    for (const sourceUrl of record.source_urls) {
      attributeUrl(sourceUrl);
    }
    for (const item of record.evidence) {
      attributeUrl(item.url);
    }

    for (const query of queriesHit) {
      let searchPage = 0;
      for (const sourceUrl of record.source_urls) {
        const normalized = normalizeUrl(sourceUrl);
        if (urlToQuery.get(normalized) === query) {
          searchPage = urlToSearchPage.get(normalized) ?? 0;
          break;
        }
      }
      if (searchPage === 0) {
        for (const item of record.evidence) {
          const normalized = normalizeUrl(item.url);
          if (urlToQuery.get(normalized) === query) {
            searchPage = urlToSearchPage.get(normalized) ?? 0;
            break;
          }
        }
      }
      applyMetricsToQuery(
        getOrCreateQueryEntry(memory, query, phase, repairLoop),
        metrics,
        searchPage,
      );
    }
  }

  for (const [query, urls] of urlsWithRecordsByQuery) {
    const entry = getOrCreateQueryEntry(memory, query, phase, repairLoop);
    entry.urls_with_records = Math.max(entry.urls_with_records, urls.size);

    const byPage = urlsWithRecordsByQueryPage.get(query);
    if (byPage) {
      for (const [page, pageUrls] of byPage) {
        const slice = getOrCreatePageSlice(entry, page);
        slice.urls_with_records = Math.max(slice.urls_with_records, pageUrls.size);
      }
    }
    recomputeWeightedQuality(entry);
  }

  for (const url of failedUrls) {
    const entry = getOrCreateDomainEntry(memory, getDomain(url), repairLoop);
    entry.fetch_failures += 1;
    entry.last_repair_loop = repairLoop;
  }

  for (const run of agentRuns) {
    const normalizedUrl = normalizeUrl(run.url);
    const domain = getDomain(run.url);

    if (run.records_extracted > 0 && run.goal) {
      const matching = records.filter((record) =>
        record.source_urls.some((u) => normalizeUrl(u) === normalizedUrl),
      );

      let goalEntry = memory.agent_goal_stats.find(
        (item) => item.url === run.url && item.goal === run.goal,
      );
      if (!goalEntry) {
        goalEntry = {
          url: run.url,
          goal: run.goal,
          repair_loop: repairLoop,
          record_count: 0,
          avg_completeness: 0,
          avg_confidence: 0,
        };
        memory.agent_goal_stats.push(goalEntry);
      }

      for (const record of matching) {
        const metrics = metricsForRecord(spec, record, context);
        goalEntry.avg_completeness = rollingAvg(
          goalEntry.avg_completeness,
          goalEntry.record_count,
          metrics.completeness,
        );
        goalEntry.avg_confidence = rollingAvg(
          goalEntry.avg_confidence,
          goalEntry.record_count,
          metrics.confidence,
        );
        goalEntry.record_count += 1;
      }
    } else {
      const domainEntry = getOrCreateDomainEntry(memory, domain, repairLoop);
      domainEntry.fetch_failures += 1;
    }
  }

  capMemoryLists(memory);
}

function capMemoryLists(memory: WorkflowMemory): void {
  if (memory.query_stats.length > 80) {
    memory.query_stats.splice(0, memory.query_stats.length - 80);
  }
  if (memory.domain_stats.length > 50) {
    memory.domain_stats.sort((a, b) => b.record_count - a.record_count);
    memory.domain_stats = memory.domain_stats.slice(0, 50);
  }
  if (memory.agent_goal_stats.length > 40) {
    memory.agent_goal_stats = memory.agent_goal_stats
      .filter((item) => item.record_count > 0)
      .slice(-40);
  }
}

export function mergeQueryEntry(
  target: QueryMemoryEntry,
  source: QueryMemoryEntry,
): void {
  const totalRecords = target.record_count + source.record_count;
  if (totalRecords > 0) {
    target.avg_completeness =
      (target.avg_completeness * target.record_count +
        source.avg_completeness * source.record_count) /
      totalRecords;
    target.avg_confidence =
      (target.avg_confidence * target.record_count +
        source.avg_confidence * source.record_count) /
      totalRecords;
  }
  target.record_count = totalRecords;
  target.urls_produced += source.urls_produced;
  target.urls_with_records += source.urls_with_records;
  target.repair_loop = Math.max(target.repair_loop, source.repair_loop);
  target.search_page = Math.max(
    target.search_page ?? 0,
    source.search_page ?? 0,
  );

  for (const slice of source.page_breakdown ?? []) {
    const targetSlice = getOrCreatePageSlice(target, slice.page);
    const combinedRecords = targetSlice.record_count + slice.record_count;
    if (combinedRecords > 0) {
      targetSlice.avg_completeness =
        (targetSlice.avg_completeness * targetSlice.record_count +
          slice.avg_completeness * slice.record_count) /
        combinedRecords;
      targetSlice.avg_confidence =
        (targetSlice.avg_confidence * targetSlice.record_count +
          slice.avg_confidence * slice.record_count) /
        combinedRecords;
    }
    targetSlice.record_count = combinedRecords;
    targetSlice.urls_produced += slice.urls_produced;
    targetSlice.urls_with_records += slice.urls_with_records;
  }
  recomputeWeightedQuality(target);
}

export function mergeDomainEntry(
  target: DomainMemoryEntry,
  source: DomainMemoryEntry,
): void {
  const totalRecords = target.record_count + source.record_count;
  if (totalRecords > 0) {
    target.avg_completeness =
      (target.avg_completeness * target.record_count +
        source.avg_completeness * source.record_count) /
      totalRecords;
    target.avg_confidence =
      (target.avg_confidence * target.record_count +
        source.avg_confidence * source.record_count) /
      totalRecords;
  }
  target.record_count = totalRecords;
  target.fetch_failures += source.fetch_failures;
  target.last_repair_loop = Math.max(target.last_repair_loop, source.last_repair_loop);
}

export function mergeAgentGoalEntry(
  target: AgentGoalMemoryEntry,
  source: AgentGoalMemoryEntry,
): void {
  const totalRecords = target.record_count + source.record_count;
  if (totalRecords > 0) {
    target.avg_completeness =
      (target.avg_completeness * target.record_count +
        source.avg_completeness * source.record_count) /
      totalRecords;
    target.avg_confidence =
      (target.avg_confidence * target.record_count +
        source.avg_confidence * source.record_count) /
      totalRecords;
  }
  target.record_count = totalRecords;
  target.repair_loop = Math.max(target.repair_loop, source.repair_loop);
}
