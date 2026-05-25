import { generateAgentGoal } from "../agents/agent-goal.js";
import { extractFromAgentResult } from "../agents/extract-from-agent.js";
import { extractFromPage } from "../agents/extract.js";
import { triagePage } from "../agents/source-triage.js";
import { derivePromptSourcePolicy } from "../agents/source-policy.js";
import { config } from "../config.js";
import { runTinyfishAgentsBatch } from "../integrations/tinyfish-agent.js";
import type { TinyfishAgentRunResult } from "../integrations/tinyfish-agent.js";
import type { WorkflowMemory } from "../memory/index.js";
import { getPrimaryKeyValue } from "../merge/records.js";
import {
  statusNeedsAgent,
  type SourceStatus,
} from "../models/source-status.js";
import type {
  AgentRunRecord,
  DatasetSpec,
  ExtractedRecord,
  FetchedPage,
  SourceTriageResult,
  TriageSummary,
} from "../models/schemas.js";
import {
  createAgentQueue,
  createExtractionQueue,
  createTriageQueue,
} from "../queue/pools.js";
import { saveJson, type RunPaths } from "../storage/run-store.js";
import { getDomain } from "../utils/url.js";
import {
  dedupeBrowserActions,
  explicitBrowserActionsFromAgentResult,
} from "./browser-actions.js";
import { join } from "node:path";

export interface AgentDeferredEntry {
  url: string;
  status: SourceStatus;
  reason: "agent_budget" | "agent_disabled";
}

export interface ProcessPagesResult {
  records: ExtractedRecord[];
  triageResults: SourceTriageResult[];
  agentRuns: AgentRunRecord[];
  agentDeferred: AgentDeferredEntry[];
  summary: TriageSummary;
}

function emptySummary(): TriageSummary {
  return {
    pages_triaged: 0,
    by_status: {},
    extract_now: 0,
    agent_candidates: 0,
    agent_dispatched: 0,
    agent_deferred: 0,
    agent_succeeded: 0,
    agent_failed: 0,
    skipped: 0,
    records_from_extract: 0,
    records_from_agent: 0,
    agent_reported_step_count: 0,
    agent_runs_with_streaming_url: 0,
    agent_runs_with_recording_url: 0,
    agent_capture_artifact_count: 0,
    agent_runs_with_explicit_browser_actions: 0,
  };
}

function recordAgentRunProvenance(
  summary: TriageSummary,
  run: TinyfishAgentRunResult,
  browserActionCount: number,
): void {
  summary.agent_reported_step_count =
    (summary.agent_reported_step_count ?? 0) +
      (run.agent_step_count ?? 0);
  if (run.has_streaming_url) {
    summary.agent_runs_with_streaming_url =
      (summary.agent_runs_with_streaming_url ?? 0) + 1;
  }
  if (run.has_recording_url) {
    summary.agent_runs_with_recording_url =
      (summary.agent_runs_with_recording_url ?? 0) + 1;
  }
  summary.agent_capture_artifact_count =
    (summary.agent_capture_artifact_count ?? 0) + run.capture_artifact_count;
  if (browserActionCount > 0) {
    summary.agent_runs_with_explicit_browser_actions =
      (summary.agent_runs_with_explicit_browser_actions ?? 0) + 1;
  }
}

function agentRunProvenanceFields(input: {
  run: TinyfishAgentRunResult;
  recordsExtracted: number;
  browserActionCount: number;
}): Pick<
  AgentRunRecord,
  | "agent_step_count"
  | "has_streaming_url"
  | "has_recording_url"
  | "capture_artifact_count"
  | "result_keys"
  | "browser_action_diagnostic"
> {
  const hasReportedBrowserWork = (input.run.agent_step_count ?? 0) > 0;
  const missingExplicitBrowserActions =
    hasReportedBrowserWork && input.browserActionCount === 0;
  const browserActionDiagnostic = missingExplicitBrowserActions
    ? input.recordsExtracted > 0
      ? "Agent completed and returned rows, but polled run payload exposed no explicit browser actions."
      : "Agent completed with reported browser work, but polled run payload exposed no explicit browser actions."
    : undefined;

  return {
    agent_step_count: input.run.agent_step_count,
    has_streaming_url: input.run.has_streaming_url,
    has_recording_url: input.run.has_recording_url,
    capture_artifact_count: input.run.capture_artifact_count,
    result_keys: input.run.result_keys,
    browser_action_diagnostic: browserActionDiagnostic,
  };
}

function bumpStatus(summary: TriageSummary, status: SourceStatus): void {
  summary.by_status[status] = (summary.by_status[status] ?? 0) + 1;
}

function shouldFallbackExtractOfficialNavigation(
  url: string,
  status: SourceStatus,
): boolean {
  if (
    status !== "requires_navigation" &&
    status !== "requires_detail_page_followup"
  ) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (
      path === "/" ||
      /(?:login|signin|signup|default\.aspx|home)(?:\/|$|\?)/.test(path)
    ) {
      return false;
    }
    return /(?:pricing|billing|docs|documentation|mcp|model-context-protocol|earnings|press-release|quarterly|results|news|blog)/.test(
      path,
    );
  } catch {
    return false;
  }
}

export async function processFetchedPages(options: {
  label: string;
  userPrompt: string;
  spec: DatasetSpec;
  pages: FetchedPage[];
  paths: RunPaths;
  errors: string[];
  focusFields?: string[];
  knownEntityKeys?: string[];
  enableTriage?: boolean;
  enableTinyfishAgent?: boolean;
  agentPollTimeoutMs?: number;
  memory?: WorkflowMemory;
  log: (stage: string, message: string) => void;
}): Promise<ProcessPagesResult> {
  const triageEnabled = options.enableTriage ?? config.enableTriage;
  const agentEnabled = options.enableTinyfishAgent ?? config.enableTinyfishAgent;
  const summary = emptySummary();
  const records: ExtractedRecord[] = [];
  const agentRuns: AgentRunRecord[] = [];
  const knownKeys = new Set(options.knownEntityKeys ?? []);
  const sourcePolicy = derivePromptSourcePolicy(options.userPrompt);

  const successfulPages = options.pages.filter(
    (page) => !page.error && page.text.trim().length > 0,
  );

  if (successfulPages.length === 0) {
    return {
      records: [],
      triageResults: [],
      agentRuns: [],
      agentDeferred: [],
      summary,
    };
  }

  const extractionQueue = createExtractionQueue();

  if (!triageEnabled) {
    options.log(
      options.label,
      `Triage disabled — extracting all pages (parallel, concurrency=${config.extractionConcurrency})...`,
    );
    const extracted = await extractionQueue.runAll(
      successfulPages,
      async (page) => {
        try {
          return await extractFromPage(options.spec, page, {
            focusFields: options.focusFields,
            memory: options.memory,
          });
        } catch (error) {
          const msg = `Extraction failed for ${page.final_url || page.url}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          options.errors.push(msg);
          return [] as ExtractedRecord[];
        }
      },
      (page) => [getDomain(page.final_url || page.url)],
    );
    const flat = extracted.flat();
    summary.pages_triaged = successfulPages.length;
    summary.extract_now = successfulPages.length;
    summary.records_from_extract = flat.length;
    return {
      records: flat,
      triageResults: [],
      agentRuns: [],
      agentDeferred: [],
      summary,
    };
  }

  const triageQueue = createTriageQueue();

  options.log(
    options.label,
    `Triaging ${successfulPages.length} pages (parallel, concurrency=${config.triageConcurrency})...`,
  );

  const triageResults = await triageQueue.runAll(
    successfulPages,
    async (page) => {
      try {
        return await triagePage({
          userPrompt: options.userPrompt,
          spec: options.spec,
          page,
          knownEntityKeys: [...knownKeys],
          memory: options.memory,
        });
      } catch (error) {
        const pageUrl = page.final_url || page.url;
        const msg = `Triage failed for ${pageUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        options.errors.push(msg);
        options.log(options.label, `WARN ${msg}`);
        return {
          url: page.url,
          final_url: pageUrl,
          title: page.title,
          status: "extract_now" as const,
          confidence: 0.3,
          source_data_confidence: 0.35,
          expected_yield: "partial" as const,
          reasoning: "Triage failed; falling back to direct extraction.",
        };
      }
    },
    (page) => [getDomain(page.final_url || page.url)],
  );

  summary.pages_triaged = triageResults.length;
  await saveJson(
    join(options.paths.root, `triage_${options.label}.json`),
    triageResults,
  );

  const pageByUrl = new Map(
    successfulPages.map((page) => [page.final_url || page.url, page]),
  );

  const extractPages: { page: FetchedPage; triage: SourceTriageResult }[] = [];
  const agentQueue: { page: FetchedPage; triage: SourceTriageResult }[] = [];
  const agentDisabledDeferredEntries: AgentDeferredEntry[] = [];

  for (const triage of triageResults) {
    bumpStatus(summary, triage.status);

    const page = pageByUrl.get(triage.final_url) ?? pageByUrl.get(triage.url);
    if (!page) continue;

    if (triage.status === "extract_now") {
      summary.extract_now += 1;
      extractPages.push({ page, triage });
    } else if (statusNeedsAgent(triage.status)) {
      summary.agent_candidates += 1;
      if (agentEnabled) {
        agentQueue.push({ page, triage });
      } else if (
        sourcePolicy.requiresOfficialSource &&
        shouldFallbackExtractOfficialNavigation(triage.final_url, triage.status)
      ) {
        options.log(
          options.label,
          `Agent disabled — intent-path fallback extract for ${triage.final_url} [${triage.status}]`,
        );
        extractPages.push({ page, triage });
      } else if (sourcePolicy.requiresOfficialSource) {
        summary.skipped += 1;
        agentDisabledDeferredEntries.push({
          url: triage.final_url || page.url,
          status: triage.status,
          reason: "agent_disabled",
        });
        options.log(
          options.label,
          `Agent disabled — skip navigation-only official source ${triage.final_url} [${triage.status}]`,
        );
      } else {
        options.log(
          options.label,
          `Agent disabled — fallback extract for ${triage.final_url} [${triage.status}]`,
        );
        extractPages.push({ page, triage });
      }
    } else {
      summary.skipped += 1;
      options.log(
        options.label,
        `Skip ${triage.final_url} [${triage.status}]: ${triage.reasoning.slice(0, 80)}`,
      );
    }
  }

  if (extractPages.length > 0) {
    options.log(
      options.label,
      `Direct extraction on ${extractPages.length} pages (parallel, concurrency=${config.extractionConcurrency})...`,
    );
    const extracted = await extractionQueue.runAll(
      extractPages,
      async ({ page }) => {
        try {
          return await extractFromPage(options.spec, page, {
            focusFields: options.focusFields,
            memory: options.memory,
          });
        } catch (error) {
          const msg = `Extraction failed for ${page.final_url || page.url}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          options.errors.push(msg);
          return [] as ExtractedRecord[];
        }
      },
      ({ page }) => [getDomain(page.final_url || page.url)],
    );
    for (const batch of extracted) {
      for (const record of batch) {
        records.push(record);
        const pk = getPrimaryKeyValue(record, options.spec);
        if (pk) knownKeys.add(pk);
      }
    }
    summary.records_from_extract = records.length;
  }

  const agentBudget = agentEnabled ? config.maxAgentRunsPerPhase : 0;
  const toRun = agentQueue.slice(0, agentBudget);
  const deferredEntries: AgentDeferredEntry[] = [
    ...agentDisabledDeferredEntries,
    ...agentQueue
      .slice(agentBudget)
      .map(({ page, triage }) => ({
        url: triage.final_url || page.url,
        status: triage.status,
        reason: "agent_budget" as const,
      })),
  ];

  if (deferredEntries.length > 0) {
    options.log(
      options.label,
      `Agent capability: running ${toRun.length}/${agentQueue.length} (${deferredEntries.length} deferred)`,
    );
  }

  summary.agent_dispatched = toRun.length;
  summary.agent_deferred = deferredEntries.length;

  if (toRun.length > 0) {
    options.log(
      options.label,
      `Tinyfish Agent on ${toRun.length} pages (async queue + poll, queue=${config.agentQueueConcurrency}, poll=${config.agentPollConcurrency})...`,
    );

    const agentGoalQueue = createAgentQueue();

    const jobsWithGoals = await agentGoalQueue.runAll(
      toRun,
      async ({ page, triage }) => {
        const pageUrl = triage.final_url || page.url;
        try {
          const agentGoal = await generateAgentGoal({
            userPrompt: options.userPrompt,
            spec: options.spec,
            triage,
            focusFields: options.focusFields,
            memory: options.memory,
          });
          return { page, triage, pageUrl, goal: agentGoal.goal, goalError: null as string | null };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          options.errors.push(`Agent goal failed for ${pageUrl}: ${msg}`);
          return { page, triage, pageUrl, goal: "", goalError: msg };
        }
      },
      ({ page }) => [getDomain(page.final_url || page.url)],
    );

    const queueJobs: { url: string; goal: string }[] = [];
    const queueJobIndices: number[] = [];

    for (let index = 0; index < jobsWithGoals.length; index++) {
      const job = jobsWithGoals[index]!;
      if (job.goalError) {
        summary.agent_failed += 1;
        agentRuns.push({
          url: job.pageUrl,
          status: job.triage.status,
          run_id: null,
          agent_status: "FAILED",
          goal: "",
          records_extracted: 0,
          error: job.goalError,
        });
        continue;
      }
      queueJobs.push({ url: job.pageUrl, goal: job.goal });
      queueJobIndices.push(index);
    }

    const agentRunResults = await runTinyfishAgentsBatch(queueJobs, {
      pollTimeoutMs: options.agentPollTimeoutMs,
    });

    const jobsToExtract = queueJobIndices.map((jobIndex, batchIndex) => ({
      job: jobsWithGoals[jobIndex]!,
      run: agentRunResults[batchIndex]!,
    }));

    await extractionQueue.runAll(
      jobsToExtract,
      async ({ job, run }) => {
        const pageUrl = job.pageUrl;
        const browserActions = dedupeBrowserActions([
          ...(run.browser_actions ?? []),
          ...explicitBrowserActionsFromAgentResult({
            agentResult: run.result,
            pageUrl,
          }),
        ]);

        if (run.error || !run.result) {
          recordAgentRunProvenance(summary, run, browserActions.length);
          summary.agent_failed += 1;
          agentRuns.push({
            url: pageUrl,
            status: job.triage.status,
            run_id: run.run_id,
            agent_status: run.status,
            goal: job.goal,
            records_extracted: 0,
            error: run.error ?? "No result returned",
            ...agentRunProvenanceFields({
              run,
              recordsExtracted: 0,
              browserActionCount: browserActions.length,
            }),
            browser_actions: browserActions.length > 0
              ? browserActions
              : undefined,
          });
          options.log(
            options.label,
            `WARN Agent failed ${pageUrl}: ${run.error ?? "no result"}`,
          );
          return;
        }

        recordAgentRunProvenance(summary, run, browserActions.length);

        try {
          const agentRecords = await extractFromAgentResult({
            spec: options.spec,
            pageUrl,
            agentResult: run.result,
            focusFields: options.focusFields,
            memory: options.memory,
          });

          summary.agent_succeeded += 1;
          for (const record of agentRecords) {
            records.push(record);
            const pk = getPrimaryKeyValue(record, options.spec);
            if (pk) knownKeys.add(pk);
          }
          summary.records_from_agent += agentRecords.length;

          agentRuns.push({
            url: pageUrl,
            status: job.triage.status,
            run_id: run.run_id,
            agent_status: run.status,
            goal: job.goal,
            records_extracted: agentRecords.length,
            ...agentRunProvenanceFields({
              run,
              recordsExtracted: agentRecords.length,
              browserActionCount: browserActions.length,
            }),
            browser_actions: browserActions.length > 0
              ? browserActions
              : undefined,
          });

          options.log(
            options.label,
            `Agent OK ${pageUrl} → ${agentRecords.length} records`,
          );
        } catch (error) {
          summary.agent_failed += 1;
          const msg = error instanceof Error ? error.message : String(error);
          options.errors.push(`Agent extract failed for ${pageUrl}: ${msg}`);
          agentRuns.push({
            url: pageUrl,
            status: job.triage.status,
            run_id: run.run_id,
            agent_status: run.status,
            goal: job.goal,
            records_extracted: 0,
            error: msg,
            ...agentRunProvenanceFields({
              run,
              recordsExtracted: 0,
              browserActionCount: browserActions.length,
            }),
            browser_actions: browserActions.length > 0
              ? browserActions
              : undefined,
          });
        }
      },
      ({ job }) => [getDomain(job.pageUrl)],
    );
  }

  if (agentRuns.length > 0) {
    await saveJson(
      join(options.paths.root, `agent_runs_${options.label}.json`),
      agentRuns,
    );
  }

  return {
    records,
    triageResults,
    agentRuns,
    agentDeferred: deferredEntries,
    summary,
  };
}
