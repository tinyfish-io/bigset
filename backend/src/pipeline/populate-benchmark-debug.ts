import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PopulateAcquisitionResult } from "./populate-acquisition.js";
import type { DatasetContext } from "./populate.js";
import type { PopulateRuntimeLimits } from "./populate-runtime-limits.js";
import type {
  PopulateRuntimeCapturedInsertedRow,
  PopulateRuntimeCapturedSource,
} from "./populate-web-types.js";
import type { DatasetSchema } from "./types.js";

export interface PopulateBenchmarkSearchPoolEntry {
  search_query: string;
  title: string;
  snippet?: string;
  url: string;
  site_name?: string;
}

export interface PopulateBenchmarkDebugSnapshot {
  runAt: string;
  context: DatasetContext;
  limits: PopulateRuntimeLimits;
  dataSpec?: DatasetSchema;
  initialQueries?: string[];
  searchPool: PopulateBenchmarkSearchPoolEntry[];
  acquisition?: PopulateAcquisitionResult;
  populatePromptUrlCount: number;
  capturedSources: PopulateRuntimeCapturedSource[];
  capturedRows: PopulateRuntimeCapturedInsertedRow[];
  validationIssues: string[];
  metrics: {
    searchCalls: number;
    fetchCalls: number;
    browserCalls: number;
    agentRuns: number;
    agentSteps: number;
  };
  notes: string[];
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isPopulateBenchmarkDebugEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.POPULATE_BENCHMARK_DEBUG?.trim().toLowerCase();
  return raw !== undefined && TRUTHY.has(raw);
}

export function populateBenchmarkArtifactDirectory(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const dir = env.BIGSET_BENCHMARK_ARTIFACT_DIR?.trim();
  return dir || undefined;
}

export async function writePopulateBenchmarkDebugArtifacts(
  artifactDirectory: string,
  snapshot: PopulateBenchmarkDebugSnapshot
): Promise<void> {
  const debugDir = join(artifactDirectory, "debug");
  await mkdir(debugDir, { recursive: true });

  const scoredCount = snapshot.acquisition?.scoredUrls.length ?? 0;
  const prioritizedCount = snapshot.acquisition?.prioritizedUrls.length ?? 0;
  const fetchedCount = snapshot.capturedSources.filter((source) =>
    isFetchedPageContent(source.text)
  ).length;

  await Promise.all([
    writeJson(join(debugDir, "run_report.json"), {
      runAt: snapshot.runAt,
      datasetId: snapshot.context.datasetId,
      description: snapshot.context.description,
      limits: snapshot.limits,
      metrics: snapshot.metrics,
      counts: {
        searchPool: snapshot.searchPool.length,
        scoredUrls: scoredCount,
        prioritizedUrls: prioritizedCount,
        populatePromptUrls: snapshot.populatePromptUrlCount,
        capturedSources: snapshot.capturedSources.length,
        fetchedPagesWithContent: fetchedCount,
        capturedRows: snapshot.capturedRows.length,
        outputRows: snapshot.capturedRows.length,
      },
      validationIssues: snapshot.validationIssues,
      notes: snapshot.notes,
    }),
    writeJson(join(debugDir, "dataset_spec.json"), snapshot.dataSpec ?? null),
    writeJson(join(debugDir, "initial_queries.json"), snapshot.initialQueries ?? []),
    writeJson(join(debugDir, "search_pool.json"), snapshot.searchPool),
    writeJson(
      join(debugDir, "source_candidates.json"),
      snapshot.acquisition?.scoredUrls ?? []
    ),
    writeJson(
      join(debugDir, "prioritized_urls.json"),
      snapshot.acquisition?.prioritizedUrls ?? []
    ),
    writeJson(join(debugDir, "captured_sources.json"), snapshot.capturedSources),
    writeJson(join(debugDir, "captured_rows.json"), snapshot.capturedRows),
    writeJson(join(debugDir, "acquisition.json"), snapshot.acquisition ?? null),
    writeCsv(join(debugDir, "prioritized_urls.csv"), prioritizedUrlsCsv(snapshot)),
    writeCsv(join(debugDir, "source_candidates.csv"), sourceCandidatesCsv(snapshot)),
  ]);
}

function prioritizedUrlsCsv(snapshot: PopulateBenchmarkDebugSnapshot): string {
  const scoreByUrl = new Map(
    (snapshot.acquisition?.scoredUrls ?? []).map((entry) => [entry.url, entry])
  );
  const lines = ["rank,url,expectation_score,search_query"];
  for (const [index, url] of (snapshot.acquisition?.prioritizedUrls ?? []).entries()) {
    const scored = scoreByUrl.get(url);
    lines.push(
      csvRow([
        String(index + 1),
        url,
        String(scored?.expectation_score ?? ""),
        scored?.search_query ?? "",
      ])
    );
  }
  return lines.join("\n");
}

function sourceCandidatesCsv(snapshot: PopulateBenchmarkDebugSnapshot): string {
  const lines = ["url,expectation_score,search_query"];
  for (const entry of snapshot.acquisition?.scoredUrls ?? []) {
    lines.push(
      csvRow([entry.url, String(entry.expectation_score), entry.search_query ?? ""])
    );
  }
  return lines.join("\n");
}

function csvRow(values: string[]): string {
  return values.map(csvEscape).join(",");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCsv(path: string, content: string): Promise<void> {
  await writeFile(path, `${content}\n`, "utf8");
}

function isFetchedPageContent(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return false;
  }
  return !trimmed.startsWith("expectation_score:");
}
