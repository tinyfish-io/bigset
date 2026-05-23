import type { PopulateAcquisitionResult } from "./populate-acquisition.js";
import { PopulateCollectionMemoryService } from "./collection-memory/index.js";
import {
  findLatestAgentVisit,
  latestTinyfishEmittedProcess,
} from "./collection-memory/store.js";
import { buildPopulateExtractionSpec } from "./populate-extraction-spec.js";
import { extractFromTinyfishAgentResult } from "./populate-extract-from-agent.js";
import { mergePopulateCandidateRows } from "./populate-merge-rows.js";
import type { DatasetContext } from "./populate.js";
import {
  resolvePopulateParallelConfig,
  type PopulateParallelConfig,
} from "./populate-parallel-config.js";
import type { PlaywrightAgentJob } from "./populate-browser-agent.js";
import { runPlaywrightAgentsBatch } from "./populate-playwright-agent.js";
import type { PopulateRuntimeLimits } from "./populate-runtime-limits.js";
import type {
  PopulateRuntimeCapturedSource,
  PopulateRuntimeWebTools,
} from "./populate-web-types.js";
import { normalizeSearchResultUrl } from "./populate-search-prioritization.js";
import type { PopulateCandidateRow } from "./populate-row.js";
import type { PopulateRuntimeRow } from "./populate-row.js";
import { triageAndExtractPage } from "./populate-triage-extract.js";
import {
  agentPriorityScore,
  buildTinyfishAgentGoal,
  runTinyfishAgentsBatch,
  type TinyfishAgentJob,
} from "./populate-tinyfish-agent.js";
import { statusNeedsTinyfishAgent } from "./populate-source-status.js";
import type { DatasetSchema, PopulateSourceTriageResult } from "./types.js";

export interface PartialPopulateWorkerResult {
  rows: PopulateCandidateRow[];
  agentCandidates: AgentDeferredCandidate[];
  capturedSources: PopulateRuntimeCapturedSource[];
  fetchCalls: number;
  llmCalls: number;
  validationIssues: string[];
}

export interface AgentDeferredCandidate {
  pageUrl: string;
  triage: PopulateSourceTriageResult;
  goal: string;
}

export interface ParallelPopulatePhaseResult {
  rows: PopulateRuntimeRow[];
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  workerCount: number;
  agentRunsDispatched: number;
}

export interface PopulateParallelHooks {
  triageAndExtractPage?: typeof triageAndExtractPage;
  extractFromTinyfishAgentResult?: typeof extractFromTinyfishAgentResult;
  runTinyfishAgentsBatch?: typeof runTinyfishAgentsBatch;
  runPlaywrightAgentsBatch?: typeof runPlaywrightAgentsBatch;
}

export function shardPrioritizedUrlsEvenly(
  urls: readonly string[],
  urlsPerWorker: number
): string[][] {
  if (urls.length === 0) {
    return [];
  }
  const workerCount = Math.max(1, Math.ceil(urls.length / urlsPerWorker));
  const shards: string[][] = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < urls.length; index += 1) {
    shards[index % workerCount]!.push(urls[index]!);
  }
  return shards.filter((shard) => shard.length > 0);
}

export async function runParallelPopulatePhase(input: {
  context: DatasetContext;
  dataSpec: DatasetSchema;
  acquisition: PopulateAcquisitionResult;
  limits: PopulateRuntimeLimits;
  webTools: PopulateRuntimeWebTools;
  metrics: {
    fetchCalls: number;
    browserCalls: number;
    agentRuns: number;
  };
  validationIssues: string[];
  debugNotes: string[];
  parallelConfig?: PopulateParallelConfig;
  hooks?: PopulateParallelHooks;
  collectionMemory?: PopulateCollectionMemoryService;
}): Promise<ParallelPopulatePhaseResult> {
  const parallelConfig = input.parallelConfig ?? resolvePopulateParallelConfig();
  const spec = buildPopulateExtractionSpec({
    context: input.context,
    dataSpec: input.dataSpec,
  });
  const triageExtract = input.hooks?.triageAndExtractPage ?? triageAndExtractPage;
  const extractAgent = input.hooks?.extractFromTinyfishAgentResult ?? extractFromTinyfishAgentResult;
  const tinyfishBatch = input.hooks?.runTinyfishAgentsBatch ?? runTinyfishAgentsBatch;
  const playwrightBatch = input.hooks?.runPlaywrightAgentsBatch ?? runPlaywrightAgentsBatch;
  const memorySnapshot = input.collectionMemory?.snapshot;

  const shards = shardPrioritizedUrlsEvenly(
    input.acquisition.prioritizedUrls,
    parallelConfig.urlsPerWorker
  );
  input.debugNotes.push(
    `Parallel populate: ${shards.length} worker shard(s), ${parallelConfig.urlsPerWorker} URL(s) per worker target, ${input.acquisition.prioritizedUrls.length} prioritized URL(s).`
  );

  const workerResults = await Promise.all(
    shards.map((urls, shardIndex) =>
      runPopulateWorkerShard({
        shardIndex,
        urls,
        userPrompt: input.context.description,
        spec,
        webTools: input.webTools,
        triageAndExtractPage: triageExtract,
      })
    )
  );

  for (const worker of workerResults) {
    input.metrics.fetchCalls += worker.fetchCalls;
    input.metrics.agentRuns += worker.llmCalls;
    input.validationIssues.push(...worker.validationIssues);
  }

  const mergedRows: PopulateCandidateRow[] = [];
  const capturedSources: PopulateRuntimeCapturedSource[] = [];
  const agentCandidates: AgentDeferredCandidate[] = [];

  for (const worker of workerResults) {
    mergedRows.push(...worker.rows);
    capturedSources.push(...worker.capturedSources);
    agentCandidates.push(...worker.agentCandidates);
  }

  let agentRunsDispatched = 0;
  if (agentCandidates.length > 0) {
    const ranked = [...agentCandidates].sort(
      (a, b) => agentPriorityScore(b.triage) - agentPriorityScore(a.triage)
    );

    const playwrightEligible: AgentDeferredCandidate[] = [];
    const tinyfishEligible: AgentDeferredCandidate[] = [];

    for (const candidate of ranked) {
      const priorProcess =
        parallelConfig.enablePlaywrightAgent && memorySnapshot
          ? latestTinyfishEmittedProcess(memorySnapshot, candidate.pageUrl)
          : undefined;
      if (priorProcess) {
        playwrightEligible.push(candidate);
      } else {
        tinyfishEligible.push(candidate);
      }
    }

    if (parallelConfig.enableTinyfishAgent && tinyfishEligible.length > 0) {
      const toRun = tinyfishEligible.slice(0, parallelConfig.maxTinyfishAgentRuns);
      const deferred = tinyfishEligible.length - toRun.length;
      if (deferred > 0) {
        input.debugNotes.push(
          `Tinyfish agent budget: running ${toRun.length}/${tinyfishEligible.length} (${deferred} deferred).`
        );
      }

      const jobs: TinyfishAgentJob[] = toRun.map((candidate) => ({
        url: candidate.pageUrl,
        goal: candidate.goal,
      }));
      agentRunsDispatched += jobs.length;
      input.metrics.browserCalls += jobs.length;

      const agentResults = await tinyfishBatch(jobs);
      for (let index = 0; index < toRun.length; index += 1) {
        const candidate = toRun[index]!;
        const run = agentResults[index]!;
        input.metrics.agentRuns += 1;
        if (run.error || !run.result) {
          input.validationIssues.push(
            `Tinyfish agent failed for ${candidate.pageUrl}: ${run.error ?? "no result"}`
          );
          continue;
        }

        input.collectionMemory?.recordAgentVisit({
          url: candidate.pageUrl,
          finalUrl: candidate.triage.final_url,
          provider: "tinyfish",
          goal: candidate.goal,
          run,
          triage: candidate.triage,
        });

        try {
          const rows = await extractAgent({
            userPrompt: input.context.description,
            spec,
            pageUrl: candidate.pageUrl,
            agentResult: run.result,
          });
          input.metrics.agentRuns += 1;
          mergedRows.push(...rows);
          capturedSources.push({
            url: candidate.pageUrl,
            text: JSON.stringify(run.result).slice(0, 12_000),
          });
        } catch (error) {
          input.validationIssues.push(
            `Tinyfish extract failed for ${candidate.pageUrl}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } else if (!parallelConfig.enableTinyfishAgent && tinyfishEligible.length > 0) {
      input.debugNotes.push(
        `Skipped ${tinyfishEligible.length} Tinyfish agent candidate(s) (POPULATE_ENABLE_TINYFISH_AGENT=false).`
      );
    }

    if (parallelConfig.enablePlaywrightAgent && playwrightEligible.length > 0) {
      const toRun = playwrightEligible.slice(0, parallelConfig.maxPlaywrightAgentRuns);
      const deferred = playwrightEligible.length - toRun.length;
      if (deferred > 0) {
        input.debugNotes.push(
          `Playwright agent budget: running ${toRun.length}/${playwrightEligible.length} (${deferred} deferred).`
        );
      }

      const jobs: PlaywrightAgentJob[] = toRun.map((candidate) => {
        const prior = memorySnapshot
          ? latestTinyfishEmittedProcess(memorySnapshot, candidate.pageUrl)
          : undefined;
        const priorVisit = memorySnapshot
          ? findLatestAgentVisit(memorySnapshot, candidate.pageUrl, "tinyfish")
          : undefined;
        return {
          url: candidate.pageUrl,
          goal: candidate.goal,
          emitted_process: prior ?? null,
          prior_tinyfish_run_id: priorVisit?.run_id ?? null,
          repair_loop: memorySnapshot?.repair_loop.current_loop ?? 0,
        };
      });

      agentRunsDispatched += jobs.length;
      input.metrics.browserCalls += jobs.length;

      const agentResults = await playwrightBatch(jobs);
      for (let index = 0; index < toRun.length; index += 1) {
        const candidate = toRun[index]!;
        const run = agentResults[index]!;
        input.metrics.agentRuns += 1;
        if (run.error || !run.result) {
          input.validationIssues.push(
            `Playwright agent failed for ${candidate.pageUrl}: ${run.error ?? "no result"}`
          );
          continue;
        }

        input.collectionMemory?.recordAgentVisit({
          url: candidate.pageUrl,
          finalUrl: candidate.triage.final_url,
          provider: "playwright",
          goal: candidate.goal,
          run,
          triage: candidate.triage,
        });

        try {
          const rows = await extractAgent({
            userPrompt: input.context.description,
            spec,
            pageUrl: candidate.pageUrl,
            agentResult: run.result,
          });
          mergedRows.push(...rows);
          capturedSources.push({
            url: candidate.pageUrl,
            text: JSON.stringify(run.result).slice(0, 12_000),
          });
        } catch (error) {
          input.validationIssues.push(
            `Playwright extract failed for ${candidate.pageUrl}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } else if (
      !parallelConfig.enablePlaywrightAgent &&
      playwrightEligible.length > 0
    ) {
      input.debugNotes.push(
        `Skipped ${playwrightEligible.length} Playwright replay candidate(s) with saved Tinyfish process (POPULATE_ENABLE_PLAYWRIGHT_AGENT=false).`
      );
    }
  }

  const merged = mergePopulateCandidateRows({
    spec,
    rows: mergedRows,
    maxRows: input.limits.maxRows,
  });
  if (merged.unkeyed.length > 0) {
    input.validationIssues.push(
      `${merged.unkeyed.length} row(s) omitted during merge (missing primary key).`
    );
  }

  input.debugNotes.push(
    `Parallel populate merged ${merged.rows.length} row(s) from ${mergedRows.length} candidate row(s).`
  );

  return {
    rows: merged.rows,
    capturedSources,
    validationIssues: input.validationIssues,
    workerCount: shards.length,
    agentRunsDispatched,
  };
}

async function runPopulateWorkerShard(input: {
  shardIndex: number;
  urls: string[];
  userPrompt: string;
  spec: ReturnType<typeof buildPopulateExtractionSpec>;
  webTools: PopulateRuntimeWebTools;
  triageAndExtractPage: typeof triageAndExtractPage;
}): Promise<PartialPopulateWorkerResult> {
  const rows: PopulateCandidateRow[] = [];
  const agentCandidates: AgentDeferredCandidate[] = [];
  const capturedSources: PopulateRuntimeCapturedSource[] = [];
  const validationIssues: string[] = [];
  let fetchCalls = 0;
  let llmCalls = 0;

  for (const url of input.urls) {
    const normalizedUrl = normalizeSearchResultUrl(url);
    fetchCalls += 1;
    let pageText = "";
    let pageTitle = "";
    try {
      const page = await input.webTools.fetch({ url: normalizedUrl });
      pageText = [page.title, page.text].filter(Boolean).join("\n");
      pageTitle = page.title ?? "";
      capturedSources.push({ url: normalizedUrl, text: pageText });
    } catch (error) {
      validationIssues.push(
        `fetch_page failed for ${normalizedUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    try {
      llmCalls += 1;
      const outcome = await input.triageAndExtractPage({
        userPrompt: input.userPrompt,
        spec: input.spec,
        page: {
          url: normalizedUrl,
          final_url: normalizedUrl,
          title: pageTitle,
          text: pageText,
        },
      });
      llmCalls += 1;

      if (outcome.records.length > 0) {
        rows.push(...outcome.records);
      }

      if (statusNeedsTinyfishAgent(outcome.triage.status)) {
        agentCandidates.push({
          pageUrl: outcome.triage.final_url || normalizedUrl,
          triage: outcome.triage,
          goal: buildTinyfishAgentGoal({
            userPrompt: input.userPrompt,
            spec: input.spec,
            triage: outcome.triage,
          }),
        });
      }
    } catch (error) {
      validationIssues.push(
        `Triage/extract failed for shard ${input.shardIndex} ${normalizedUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    rows,
    agentCandidates,
    capturedSources,
    fetchCalls,
    llmCalls,
    validationIssues,
  };
}
