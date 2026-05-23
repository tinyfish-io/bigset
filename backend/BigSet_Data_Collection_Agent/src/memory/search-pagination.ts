import { config } from "../config.js";
import type { QueryMemoryEntry, WorkflowMemory } from "./types.js";

export interface SearchPlan {
  /** Base query string sent to the Search API. */
  query: string;
  /** Search API page index (0-based, max 10). */
  page: number;
}

/** Front pages count more toward recurring-search ranking. */
const PAGE_WEIGHTS = [1.0, 0.75, 0.5, 0.35, 0.25, 0.2, 0.15, 0.12, 0.1, 0.08, 0.05];

export function pageWeight(page: number): number {
  if (page < 0) return 0.05;
  return PAGE_WEIGHTS[page] ?? 0.05;
}

export function effectiveWeightedQuality(entry: QueryMemoryEntry): number {
  if (entry.weighted_quality > 0) return entry.weighted_quality;
  if (entry.record_count <= 0) return 0;
  return (entry.avg_completeness + entry.avg_confidence) / 2;
}

export function recomputeWeightedQuality(entry: QueryMemoryEntry): void {
  const breakdown = entry.page_breakdown ?? [];
  if (breakdown.length === 0) {
    entry.weighted_quality =
      entry.record_count > 0
        ? (entry.avg_completeness + entry.avg_confidence) / 2
        : 0;
    return;
  }

  let numerator = 0;
  let denominator = 0;
  for (const slice of breakdown) {
    if (slice.record_count <= 0) continue;
    const w = pageWeight(slice.page) * slice.record_count;
    const q = (slice.avg_completeness + slice.avg_confidence) / 2;
    numerator += w * q;
    denominator += w;
  }
  entry.weighted_quality = denominator > 0 ? numerator / denominator : 0;
}

/** Roll up stats for the same query text across phases. */
export function aggregateQueryStatsByText(
  memory: WorkflowMemory,
): Map<string, QueryMemoryEntry & { phases: string[] }> {
  const map = new Map<string, QueryMemoryEntry & { phases: string[] }>();

  for (const item of memory.query_stats) {
    const existing = map.get(item.query);
    if (!existing) {
      map.set(item.query, {
        ...item,
        phases: [item.phase],
        search_page: item.search_page ?? 0,
        weighted_quality: item.weighted_quality ?? 0,
        page_breakdown: [...(item.page_breakdown ?? [])],
      });
      continue;
    }

    existing.phases.push(item.phase);
    existing.record_count += item.record_count;
    existing.urls_produced += item.urls_produced;
    existing.urls_with_records += item.urls_with_records;
    existing.search_page = Math.max(
      existing.search_page ?? 0,
      item.search_page ?? 0,
    );
    existing.repair_loop = Math.max(existing.repair_loop, item.repair_loop);

    const totalRecords = existing.record_count;
    if (totalRecords > 0) {
      const prevCount = totalRecords - item.record_count;
      if (prevCount > 0) {
        existing.avg_completeness =
          (existing.avg_completeness * prevCount +
            item.avg_completeness * item.record_count) /
          totalRecords;
        existing.avg_confidence =
          (existing.avg_confidence * prevCount +
            item.avg_confidence * item.record_count) /
          totalRecords;
      } else {
        existing.avg_completeness = item.avg_completeness;
        existing.avg_confidence = item.avg_confidence;
      }
    }

    for (const slice of item.page_breakdown ?? []) {
      const target = existing.page_breakdown!.find((p) => p.page === slice.page);
      if (!target) {
        existing.page_breakdown!.push({ ...slice });
      } else {
        const combined = target.record_count + slice.record_count;
        if (combined > 0) {
          target.avg_completeness =
            (target.avg_completeness * target.record_count +
              slice.avg_completeness * slice.record_count) /
            combined;
          target.avg_confidence =
            (target.avg_confidence * target.record_count +
              slice.avg_confidence * slice.record_count) /
            combined;
        }
        target.record_count = combined;
        target.urls_produced += slice.urls_produced;
        target.urls_with_records += slice.urls_with_records;
      }
    }
    recomputeWeightedQuality(existing);
  }

  return map;
}

/** New repair queries at page 0; top historical queries at the next page. */
export function planRepairSearches(
  memory: WorkflowMemory,
  newQueries: string[],
): SearchPlan[] {
  const plans: SearchPlan[] = [];
  const seen = new Set<string>();

  for (const raw of newQueries) {
    const query = raw.trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    plans.push({ query, page: 0 });
  }

  const aggregated = aggregateQueryStatsByText(memory);
  const top = [...aggregated.values()]
    .filter((item) => item.record_count > 0)
    .sort(
      (a, b) => effectiveWeightedQuality(b) - effectiveWeightedQuality(a),
    )
    .slice(0, config.maxRepairSearchPaginationQueries);

  for (const entry of top) {
    const nextPage = (entry.search_page ?? 0) + 1;
    if (nextPage > config.maxSearchPage) continue;
    if (seen.has(entry.query)) continue;
    seen.add(entry.query);
    plans.push({ query: entry.query, page: nextPage });
  }

  return plans;
}

/** After a repair search pass, persist the highest page used per query. */
export function markSearchPagesUsed(
  memory: WorkflowMemory,
  plans: SearchPlan[],
  phase: string,
  repairLoop: number,
): void {
  for (const plan of plans) {
    let entry = memory.query_stats.find(
      (item) => item.query === plan.query && item.phase === phase,
    );
    if (!entry) {
      entry = {
        query: plan.query,
        phase,
        repair_loop: repairLoop,
        urls_produced: 0,
        urls_with_records: 0,
        record_count: 0,
        avg_completeness: 0,
        avg_confidence: 0,
        search_page: plan.page,
        weighted_quality: 0,
        page_breakdown: [],
      };
      memory.query_stats.push(entry);
    }
    entry.search_page = Math.max(entry.search_page ?? 0, plan.page);
  }
}
