import { generateAgentGoal } from "../agents/agent-goal.js";
import { extractFromAgentResult } from "../agents/extract-from-agent.js";
import { extractFromPage } from "../agents/extract.js";
import { triagePage } from "../agents/source-triage.js";
import {
  triageAndExtractPage,
  type SourceTriageExtractOutcome,
} from "../agents/triage-extract.js";
import { config } from "../config.js";
import { runTinyfishAgentsBatch } from "../integrations/tinyfish-agent.js";
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
import { join } from "node:path";

export interface AgentDeferredEntry {
  url: string;
  status: SourceStatus;
}

export interface ProcessPagesResult {
  records: ExtractedRecord[];
  triageResults: SourceTriageResult[];
  sourceOutcomes: SourceTriageExtractOutcome[];
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
  };
}

function bumpStatus(summary: TriageSummary, status: SourceStatus): void {
  summary.by_status[status] = (summary.by_status[status] ?? 0) + 1;
}

function fallbackTriage(page: FetchedPage, error: unknown): SourceTriageResult {
  const pageUrl = page.final_url || page.url;
  return {
    url: page.url,
    final_url: pageUrl,
    title: page.title,
    status: "extract_now",
    confidence: 0.3,
    source_data_confidence: 0.35,
    expected_yield: "partial",
    reasoning: `Triage failed; falling back to direct extraction. ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

function appendRecords(
  records: ExtractedRecord[],
  batch: ExtractedRecord[],
  knownKeys: Set<string>,
  spec: DatasetSpec,
): void {
  for (const record of batch) {
    records.push(record);
    const pk = getPrimaryKeyValue(record, spec);
    if (pk) knownKeys.add(pk);
  }
}

async function runAgentPhase(options: {
  label: string;
  userPrompt: string;
  spec: DatasetSpec;
  agentQueue: { page: FetchedPage; triage: SourceTriageResult }[];
  agentEnabled: boolean;
  focusFields?: string[];
  memory?: WorkflowMemory;
  records: ExtractedRecord[];
  knownKeys: Set<string>;
  agentRuns: AgentRunRecord[];
  summary: TriageSummary;
  errors: string[];
  log: (stage: string, message: string) => void;
}): Promise<AgentDeferredEntry[]> {
  const agentBudget = options.agentEnabled ? config.maxAgentRunsPerPhase : 0;
  const toRun = options.agentQueue.slice(0, agentBudget);
  const deferredEntries: AgentDeferredEntry[] = options.agentQueue
    .slice(agentBudget)
    .map(({ page, triage }) => ({
      url: triage.final_url || page.url,
      status: triage.status,
    }));

  if (deferredEntries.length > 0) {
    options.log(
      options.label,
      `Agent budget: running ${toRun.length}/${options.agentQueue.length} (${deferredEntries.length} deferred)`,
    );
  }

  options.summary.agent_dispatched = toRun.length;
  options.summary.agent_deferred = deferredEntries.length;

  if (toRun.length === 0) {
    return deferredEntries;
  }

  options.log(
    options.label,
    `Tinyfish Agent on ${toRun.length} pages (triage-only routing; extract after agent) — queue=${config.agentQueueConcurrency}, poll=${config.agentPollConcurrency}...`,
  );

  const agentGoalQueue = createAgentQueue();
  const extractionQueue = createExtractionQueue();

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
      options.summary.agent_failed += 1;
      options.agentRuns.push({
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

  const agentRunResults = await runTinyfishAgentsBatch(queueJobs);

  const jobsToExtract = queueJobIndices.map((jobIndex, batchIndex) => ({
    job: jobsWithGoals[jobIndex]!,
    run: agentRunResults[batchIndex]!,
  }));

  await extractionQueue.runAll(
    jobsToExtract,
    async ({ job, run }) => {
      const pageUrl = job.pageUrl;

      if (run.error || !run.result) {
        options.summary.agent_failed += 1;
        options.agentRuns.push({
          url: pageUrl,
          status: job.triage.status,
          run_id: run.run_id,
          agent_status: run.status,
          goal: job.goal,
          records_extracted: 0,
          error: run.error ?? "No result returned",
        });
        options.log(
          options.label,
          `WARN Agent failed ${pageUrl}: ${run.error ?? "no result"}`,
        );
        return;
      }

      try {
        const agentRecords = await extractFromAgentResult({
          spec: options.spec,
          pageUrl,
          agentResult: run.result,
          focusFields: options.focusFields,
          memory: options.memory,
        });

        options.summary.agent_succeeded += 1;
        appendRecords(options.records, agentRecords, options.knownKeys, options.spec);
        options.summary.records_from_agent += agentRecords.length;

        options.agentRuns.push({
          url: pageUrl,
          status: job.triage.status,
          run_id: run.run_id,
          agent_status: run.status,
          goal: job.goal,
          records_extracted: agentRecords.length,
        });

        options.log(
          options.label,
          `Agent OK ${pageUrl} → ${agentRecords.length} records`,
        );
      } catch (error) {
        options.summary.agent_failed += 1;
        const msg = error instanceof Error ? error.message : String(error);
        options.errors.push(`Agent extract failed for ${pageUrl}: ${msg}`);
        options.agentRuns.push({
          url: pageUrl,
          status: job.triage.status,
          run_id: run.run_id,
          agent_status: run.status,
          goal: job.goal,
          records_extracted: 0,
          error: msg,
        });
      }
    },
    ({ job }) => [getDomain(job.pageUrl)],
  );

  return deferredEntries;
}

async function processWithSeparateTriageExtract(options: {
  label: string;
  userPrompt: string;
  spec: DatasetSpec;
  successfulPages: FetchedPage[];
  paths: RunPaths;
  errors: string[];
  focusFields?: string[];
  knownKeys: Set<string>;
  enableTinyfishAgent: boolean;
  memory?: WorkflowMemory;
  log: (stage: string, message: string) => void;
  records: ExtractedRecord[];
  summary: TriageSummary;
}): Promise<{
  triageResults: SourceTriageResult[];
  sourceOutcomes: SourceTriageExtractOutcome[];
  agentQueue: { page: FetchedPage; triage: SourceTriageResult }[];
}> {
  const triageQueue = createTriageQueue();
  const extractionQueue = createExtractionQueue();

  options.log(
    options.label,
    `Triaging ${options.successfulPages.length} pages (legacy separate extract, concurrency=${config.triageConcurrency})...`,
  );

  const triageResults = await triageQueue.runAll(
    options.successfulPages,
    async (page) => {
      try {
        return await triagePage({
          userPrompt: options.userPrompt,
          spec: options.spec,
          page,
          knownEntityKeys: [...options.knownKeys],
          memory: options.memory,
        });
      } catch (error) {
        const pageUrl = page.final_url || page.url;
        const msg = `Triage failed for ${pageUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        options.errors.push(msg);
        options.log(options.label, `WARN ${msg}`);
        return fallbackTriage(page, error);
      }
    },
    (page) => [getDomain(page.final_url || page.url)],
  );

  const sourceOutcomes: SourceTriageExtractOutcome[] = triageResults.map((triage) => ({
    url: triage.url,
    final_url: triage.final_url,
    triage_results: triage,
    extraction_results: null,
  }));

  const pageByUrl = new Map(
    options.successfulPages.map((page) => [page.final_url || page.url, page]),
  );

  const extractPages: { page: FetchedPage; triage: SourceTriageResult }[] = [];
  const agentQueue: { page: FetchedPage; triage: SourceTriageResult }[] = [];

  for (const triage of triageResults) {
    bumpStatus(options.summary, triage.status);
    const page = pageByUrl.get(triage.final_url) ?? pageByUrl.get(triage.url);
    if (!page) continue;

    if (triage.status === "extract_now") {
      options.summary.extract_now += 1;
      extractPages.push({ page, triage });
    } else if (statusNeedsAgent(triage.status)) {
      options.summary.agent_candidates += 1;
      if (options.enableTinyfishAgent) {
        agentQueue.push({ page, triage });
      } else {
        options.log(
          options.label,
          `Agent disabled — fallback extract for ${triage.final_url} [${triage.status}]`,
        );
        extractPages.push({ page, triage });
      }
    } else {
      options.summary.skipped += 1;
      options.log(
        options.label,
        `Skip ${triage.final_url} [${triage.status}]: ${triage.reasoning.slice(0, 80)}`,
      );
    }
  }

  if (extractPages.length > 0) {
    options.log(
      options.label,
      `Direct extraction on ${extractPages.length} pages (legacy, concurrency=${config.extractionConcurrency})...`,
    );
    const extracted = await extractionQueue.runAll(
      extractPages,
      async ({ page, triage }) => {
        try {
          const pageRecords = await extractFromPage(options.spec, page, {
            focusFields: options.focusFields,
            memory: options.memory,
          });
          const outcome = sourceOutcomes.find(
            (item) => item.final_url === triage.final_url || item.url === triage.url,
          );
          if (outcome) {
            outcome.extraction_results = {
              records: pageRecords,
            };
          }
          return pageRecords;
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
      appendRecords(options.records, batch, options.knownKeys, options.spec);
    }
    options.summary.records_from_extract = options.records.length;
  }

  return { triageResults, sourceOutcomes, agentQueue };
}

async function processWithCombinedTriageExtract(options: {
  label: string;
  userPrompt: string;
  spec: DatasetSpec;
  successfulPages: FetchedPage[];
  errors: string[];
  focusFields?: string[];
  knownKeys: Set<string>;
  enableTinyfishAgent: boolean;
  memory?: WorkflowMemory;
  log: (stage: string, message: string) => void;
  records: ExtractedRecord[];
  summary: TriageSummary;
}): Promise<{
  triageResults: SourceTriageResult[];
  sourceOutcomes: SourceTriageExtractOutcome[];
  agentQueue: { page: FetchedPage; triage: SourceTriageResult }[];
}> {
  const triageQueue = createTriageQueue();
  options.log(
    options.label,
    `Combined triage+extract on ${options.successfulPages.length} pages (concurrency=${config.triageConcurrency}, ${config.triageExtractMaxPageChars} chars/page)...`,
  );

  const outcomes = await triageQueue.runAll(
    options.successfulPages,
    async (page) => {
      try {
        return await triageAndExtractPage({
          userPrompt: options.userPrompt,
          spec: options.spec,
          page,
          knownEntityKeys: [...options.knownKeys],
          memory: options.memory,
          focusFields: options.focusFields,
        });
      } catch (error) {
        const pageUrl = page.final_url || page.url;
        const msg = `Triage-extract failed for ${pageUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        options.errors.push(msg);
        options.log(options.label, `WARN ${msg}`);
        const triage = fallbackTriage(page, error);
        let records: ExtractedRecord[] = [];
        try {
          records = await extractFromPage(options.spec, page, {
            focusFields: options.focusFields,
            memory: options.memory,
          });
        } catch (extractError) {
          options.errors.push(
            `Fallback extraction failed for ${pageUrl}: ${
              extractError instanceof Error ? extractError.message : String(extractError)
            }`,
          );
        }
        return {
          triage,
          records,
          outcome: {
            url: page.url,
            final_url: pageUrl,
            triage_results: triage,
            extraction_results: records.length
              ? { records }
              : null,
          },
        };
      }
    },
    (page) => [getDomain(page.final_url || page.url)],
  );

  const triageResults: SourceTriageResult[] = [];
  const sourceOutcomes: SourceTriageExtractOutcome[] = [];
  const agentQueue: { page: FetchedPage; triage: SourceTriageResult }[] = [];
  const pageByUrl = new Map(
    options.successfulPages.map((page) => [page.final_url || page.url, page]),
  );

  for (const result of outcomes) {
    triageResults.push(result.triage);
    sourceOutcomes.push(result.outcome);
    bumpStatus(options.summary, result.triage.status);

    const page =
      pageByUrl.get(result.triage.final_url) ?? pageByUrl.get(result.triage.url);
    if (!page) continue;

    if (result.triage.status === "extract_now") {
      options.summary.extract_now += 1;
      appendRecords(options.records, result.records, options.knownKeys, options.spec);
    } else if (statusNeedsAgent(result.triage.status)) {
      options.summary.agent_candidates += 1;
      if (options.enableTinyfishAgent) {
        agentQueue.push({ page, triage: result.triage });
      } else {
        options.log(
          options.label,
          `Agent disabled — fallback extract for ${result.triage.final_url} [${result.triage.status}]`,
        );
        try {
          const pageRecords = await extractFromPage(options.spec, page, {
            focusFields: options.focusFields,
            memory: options.memory,
          });
          const outcome = sourceOutcomes.find(
            (item) =>
              item.final_url === result.triage.final_url ||
              item.url === result.triage.url,
          );
          if (outcome) {
            outcome.extraction_results = { records: pageRecords };
          }
          appendRecords(options.records, pageRecords, options.knownKeys, options.spec);
        } catch (error) {
          const msg = `Fallback extraction failed for ${result.triage.final_url}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          options.errors.push(msg);
        }
      }
    } else {
      options.summary.skipped += 1;
      options.log(
        options.label,
        `Skip ${result.triage.final_url} [${result.triage.status}]: ${result.triage.reasoning.slice(0, 80)}`,
      );
    }
  }

  options.summary.records_from_extract = options.records.length;

  return { triageResults, sourceOutcomes, agentQueue };
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
  memory?: WorkflowMemory;
  log: (stage: string, message: string) => void;
}): Promise<ProcessPagesResult> {
  const triageEnabled = options.enableTriage ?? config.enableTriage;
  const agentEnabled = options.enableTinyfishAgent ?? config.enableTinyfishAgent;
  const summary = emptySummary();
  const records: ExtractedRecord[] = [];
  const agentRuns: AgentRunRecord[] = [];
  const knownKeys = new Set(options.knownEntityKeys ?? []);

  const successfulPages = options.pages.filter(
    (page) => !page.error && page.text.trim().length > 0,
  );

  if (successfulPages.length === 0) {
    return {
      records: [],
      triageResults: [],
      sourceOutcomes: [],
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
      sourceOutcomes: [],
      agentRuns: [],
      agentDeferred: [],
      summary,
    };
  }

  const shared = {
    label: options.label,
    userPrompt: options.userPrompt,
    spec: options.spec,
    successfulPages,
    paths: options.paths,
    errors: options.errors,
    focusFields: options.focusFields,
    knownKeys,
    enableTinyfishAgent: agentEnabled,
    memory: options.memory,
    log: options.log,
    records,
    summary,
  };

  const { triageResults, sourceOutcomes, agentQueue } =
    config.enableCombinedTriageExtract
      ? await processWithCombinedTriageExtract(shared)
      : await processWithSeparateTriageExtract(shared);

  summary.pages_triaged = triageResults.length;

  await saveJson(
    join(options.paths.root, `triage_${options.label}.json`),
    triageResults,
  );
  await saveJson(
    join(options.paths.root, `source_outcomes_${options.label}.json`),
    sourceOutcomes,
  );

  const deferredEntries = await runAgentPhase({
    label: options.label,
    userPrompt: options.userPrompt,
    spec: options.spec,
    agentQueue,
    agentEnabled,
    focusFields: options.focusFields,
    memory: options.memory,
    records,
    knownKeys,
    agentRuns,
    summary,
    errors: options.errors,
    log: options.log,
  });

  if (agentRuns.length > 0) {
    await saveJson(
      join(options.paths.root, `agent_runs_${options.label}.json`),
      agentRuns,
    );
  }

  return {
    records,
    triageResults,
    sourceOutcomes,
    agentRuns,
    agentDeferred: deferredEntries,
    summary,
  };
}
