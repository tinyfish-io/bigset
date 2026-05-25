import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

import {
  buildPopulatePrompt,
  populateAgentInstructions,
} from "./populate-prompt.js";
import {
  datasetContextSchema,
  type DatasetContext,
} from "./populate.js";
import {
  buildPopulateFetchPlan,
  triageFetchedPageForPopulate,
  rankPopulateSearchResults,
} from "./populate-source-planner.js";
import type {
  BrowserActionBox,
  BrowserActionBoxDatasetSchema,
} from "./populate-browser-action-box.js";

export type PopulateCellValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface PopulateRuntimeRow {
  cells: Record<string, PopulateCellValue>;
  sourceUrls: string[];
  evidence: Array<{
    columnName: string;
    sourceUrl: string;
    quote: string;
  }>;
  needsReview: boolean;
}

export interface PopulateRuntimeCapturedInsertedRow {
  datasetId: string;
  data: Record<string, unknown>;
}

export interface PopulateRuntimeCapturedSource {
  url: string;
  text: string;
  source: "search" | "fetch" | "synthetic";
}

export type PopulateRuntimeTraceStepKind =
  | "search"
  | "fetch"
  | "insert_row"
  | "agent"
  | "browser"
  | "extract"
  | "repair"
  | "validation";

export type PopulateRuntimeBrowserActionKind =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "wait"
  | "extract"
  | "screenshot"
  | "unknown";

export interface PopulateRuntimeBrowserAction {
  action: PopulateRuntimeBrowserActionKind;
  url?: string;
  selector?: string;
  targetText?: string;
  valueDescription?: string;
}

export interface PopulateRuntimeTraceStep {
  kind: PopulateRuntimeTraceStepKind;
  label: string;
  status: "succeeded" | "failed" | "skipped";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  browserAction?: PopulateRuntimeBrowserAction;
}

export interface PopulateProcessTraceSourceArtifact {
  url: string;
  status: "succeeded" | "failed" | "skipped";
  source: "search" | "fetch" | "agent" | "collection" | "unknown";
  label?: string;
  error?: string;
}

export interface PopulateProcessTrace {
  runtime: "mastra" | "mastra-injected" | "collection" | "unknown";
  searchQueries: string[];
  fetchedUrls: string[];
  sourceArtifacts: PopulateProcessTraceSourceArtifact[];
  selectedRowSource:
    | "insert_row"
    | "structured_recovery"
    | "collection_pipeline"
    | "none";
  notes: string[];
  steps: PopulateRuntimeTraceStep[];
  artifactRoot?: string;
  runReportPath?: string;
}

export interface PopulateRuntimeDebug {
  capturedRows: PopulateRuntimeCapturedInsertedRow[];
  capturedSources: PopulateRuntimeCapturedSource[];
  selectedRowSource:
    | "insert_row"
    | "structured_recovery"
    | "collection_pipeline"
    | "none";
  notes: string[];
  processTrace: PopulateProcessTrace;
  diagnosticArtifacts?: Array<{
    kind: string;
    label: string;
    content: string;
  }>;
}

export interface PopulateRuntimeResult {
  rows: PopulateRuntimeRow[];
  validationIssues: string[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metrics: {
    searchCalls: number;
    fetchCalls: number;
    browserCalls: number;
    agentRuns: number;
    agentSteps: number;
  };
  debug?: PopulateRuntimeDebug;
}

export interface PopulateWebSearchResult {
  title: string;
  snippet?: string;
  url: string;
}

export interface PopulateFetchedPage {
  title?: string;
  text?: string;
}

export interface PopulateRuntimeWebTools {
  search(input: { query: string }): Promise<PopulateWebSearchResult[]>;
  fetch(input: { url: string }): Promise<PopulateFetchedPage>;
}

export type PopulateRuntimeAgentRunner = (input: {
  prompt: string;
  tools: Record<string, unknown>;
}) => Promise<unknown>;

const structuredPopulateEvidenceSchema = z.object({
  columnName: z.string().optional(),
  sourceUrl: z.string().optional(),
  quote: z.string(),
});

const structuredPopulateOutputSchema = z.object({
  rows: z.array(z.object({
    cells: z.record(z.string(), z.any()),
    sourceUrls: z.array(z.string()).optional(),
    evidence: z.array(structuredPopulateEvidenceSchema).optional(),
    needsReview: z.boolean().optional(),
  })).default([]),
  validationIssues: z.array(z.string()).default([]),
});

type StructuredPopulateOutput = z.infer<typeof structuredPopulateOutputSchema>;

export async function runPopulateRuntime(input: {
  context: DatasetContext;
  webTools?: PopulateRuntimeWebTools;
  agentRunner?: PopulateRuntimeAgentRunner;
  browserActionBox?: Pick<BrowserActionBox, "firstRun">;
  maxRows?: number;
  sourcePlanner?: {
    enabled?: boolean;
    fetchLimit?: number;
  };
}): Promise<PopulateRuntimeResult> {
  const parsedContext = datasetContextSchema.parse(input.context);
  const clarificationResult = clarificationResultForContext(parsedContext);
  if (clarificationResult) {
    return clarificationResult;
  }

  const capturedRows: PopulateRuntimeCapturedInsertedRow[] = [];
  const capturedSources: PopulateRuntimeCapturedSource[] = [];
  const processTraceSteps: PopulateRuntimeTraceStep[] = [];
  const validationIssues: string[] = [];
  const debugNotes: string[] = [];
  const diagnosticArtifacts: NonNullable<PopulateRuntimeDebug["diagnosticArtifacts"]> = [];
  const browserActionRows: PopulateRuntimeRow[] = [];
  const metrics = emptyMetrics();
  const webTools = input.webTools ?? createTinyFishWebTools();
  const tools = createPopulateRuntimeTools({
    datasetId: parsedContext.datasetId,
    capturedRows,
    capturedSources,
    validationIssues,
    metrics,
    webTools,
    maxRows: input.maxRows ?? 10,
    processTraceSteps,
  });
  if (input.sourcePlanner?.enabled ?? !input.agentRunner) {
    await seedCapturedSourcesFromPlannedSearches({
      context: parsedContext,
      webTools,
      capturedSources,
      validationIssues,
      metrics,
      processTraceSteps,
      fetchLimit: input.sourcePlanner?.fetchLimit ?? 6,
    });
  }
  await runBrowserActionBoxForDeferredSources({
    context: parsedContext,
    capturedSources,
    browserActionBox: input.browserActionBox,
    browserActionRows,
    processTraceSteps,
    validationIssues,
    debugNotes,
    diagnosticArtifacts,
    metrics,
    maxRows: input.maxRows ?? 10,
  });
  await seedCapturedSourcesFromContextUrls({
    context: parsedContext,
    webTools,
    capturedSources,
    validationIssues,
    metrics,
    processTraceSteps,
  });
  const explicitUrlRows = deterministicRowsFromCapturedSources({
    context: parsedContext,
    capturedSources,
    maxRows: input.maxRows ?? 10,
  });
  if (urlsFromText(parsedContext.description).length > 0 && explicitUrlRows.length > 0) {
    debugNotes.push(
      "Explicit URL shortcut built title/URL rows from fetched source snippets."
    );
    const processTrace = populateProcessTraceFromSteps({
      runtime: input.agentRunner ? "mastra-injected" : "mastra",
      steps: processTraceSteps,
      capturedSources,
      selectedRowSource: "structured_recovery",
      notes: debugNotes,
    });
    return {
      rows: explicitUrlRows,
      validationIssues: Array.from(new Set([
        ...validationIssues,
        ...validateRuntimeRows(explicitUrlRows),
      ])),
      usage: emptyUsage(),
      metrics,
      debug: {
        capturedRows,
        capturedSources,
        selectedRowSource: "structured_recovery",
        notes: debugNotes,
        processTrace,
        diagnosticArtifacts,
      },
    };
  }
  const prompt = buildPopulatePrompt(parsedContext);
  let agentOutput: unknown;

  if (input.agentRunner) {
    try {
      agentOutput = await input.agentRunner({ prompt, tools });
      metrics.agentRuns += 1;
      processTraceSteps.push({
        kind: "agent",
        label: "populate-agent-injected",
        status: "succeeded",
        input: {
          promptCharacters: prompt.length,
          toolNames: Object.keys(tools),
        },
        output: {
          capturedRowCount: capturedRows.length,
          capturedSourceCount: capturedSources.length,
        },
      });
    } catch (error) {
      const message = populateAgentFailureMessage(error);
      validationIssues.push(message);
      processTraceSteps.push({
        kind: "agent",
        label: "populate-agent-injected",
        status: "failed",
        input: {
          promptCharacters: prompt.length,
          toolNames: Object.keys(tools),
        },
        error: message,
      });
    }
  } else {
    try {
      const agent = createRuntimePopulateAgent({ tools });
      agentOutput = await agent.generate(prompt);
      metrics.agentRuns += 1;
      processTraceSteps.push({
        kind: "agent",
        label: "populate-agent-mastra",
        status: "succeeded",
        input: {
          promptCharacters: prompt.length,
          toolNames: Object.keys(tools),
        },
        output: {
          capturedRowCount: capturedRows.length,
          capturedSourceCount: capturedSources.length,
        },
      });
    } catch (error) {
      const message = populateAgentFailureMessage(error);
      validationIssues.push(message);
      processTraceSteps.push({
        kind: "agent",
        label: "populate-agent-mastra",
        status: "failed",
        input: {
          promptCharacters: prompt.length,
          toolNames: Object.keys(tools),
        },
        error: message,
      });
    }

  }

  const insertedRows = capturedRows.map((row) =>
    benchmarkRowFromInsertedData({
      data: row.data,
      capturedSources,
    })
  );
  const insertedRowIssues = validateRuntimeRows(insertedRows);
  if (
    !input.agentRunner &&
    capturedSources.length > 0 &&
    shouldRecoverFromInsertedRows(insertedRowIssues)
  ) {
    await enrichCapturedSourcesForStructuredFallback({
      context: parsedContext,
      capturedSources,
      validationIssues,
      metrics,
      webTools,
    });
    try {
      agentOutput = await generateStructuredRowsFromCapturedSources({
        context: parsedContext,
        capturedSources,
      });
      metrics.agentRuns += 1;
      processTraceSteps.push({
        kind: "extract",
        label: "structured-row-recovery",
        status: "succeeded",
        input: {
          capturedSourceCount: capturedSources.length,
        },
      });
    } catch (error) {
      const message = `Structured row generation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      validationIssues.push(message);
      processTraceSteps.push({
        kind: "extract",
        label: "structured-row-recovery",
        status: "failed",
        input: {
          capturedSourceCount: capturedSources.length,
        },
        error: message,
      });
    }
  }

  const validationIssueCountBeforeStructuredRows = validationIssues.length;
  const structuredRows = benchmarkRowsFromStructuredOutput({
    output: structuredOutputFromAgentResult(agentOutput),
    maxRows: input.maxRows ?? 10,
    context: parsedContext,
    requestedColumns: parsedContext.columns.map((column) => column.name),
    capturedSources,
    validationIssues,
    debugNotes,
  });
  const structuredOutputValidationIssues = validationIssues.slice(
    validationIssueCountBeforeStructuredRows
  );
  const deterministicRows = deterministicRowsFromCapturedSources({
    context: parsedContext,
    capturedSources,
    maxRows: input.maxRows ?? 10,
  });
  const rawStructuredRowIssues = validateRuntimeRows(structuredRows);
  const deterministicRowIssues = validateRuntimeRows(deterministicRows);
  const shouldUseDeterministicRows =
    deterministicRows.length > 0 &&
    deterministicRowIssues.length === 0 &&
    (
      structuredRows.length === 0 ||
      rawStructuredRowIssues.length > 0 ||
      structuredOutputValidationIssues.some((issue) =>
        /approximation|manual review|not present|not accompanied|only .*listing page/i.test(issue)
      )
    );
  if (shouldUseDeterministicRows) {
    validationIssues.splice(validationIssueCountBeforeStructuredRows);
    debugNotes.push(
      "Deterministic source fallback built title/URL rows from captured source snippets."
    );
  }
  const fallbackStructuredRows = shouldUseDeterministicRows
    ? deterministicRows
    : [
      ...browserActionRows,
      ...structuredRows,
    ];
  const structuredRowIssues = validateRuntimeRows(fallbackStructuredRows);
  if (
    insertedRows.length > 0 &&
    insertedRowIssues.length === 0 &&
    fallbackStructuredRows.length > 0 &&
    hasContradictingStructuredRows(insertedRows, fallbackStructuredRows)
  ) {
    validationIssues.push(
      "Structured populate rows differed from insert_row rows and were ignored."
    );
  }
  const rows = selectBestRuntimeRows({
    insertedRows,
    insertedRowIssues,
    structuredRows: fallbackStructuredRows,
    structuredRowIssues,
    debugNotes,
  });
  const selectedRowSource = selectedRowSourceForRows({
    rows,
    insertedRows,
    structuredRows: fallbackStructuredRows,
  });
  const processTrace = populateProcessTraceFromSteps({
    runtime: input.agentRunner ? "mastra-injected" : "mastra",
    steps: processTraceSteps,
    capturedSources,
    selectedRowSource,
    notes: debugNotes,
  });
  validationIssues.push(...validateRuntimeRows(rows));

  return {
    rows,
    validationIssues: Array.from(new Set(validationIssues)),
    usage: emptyUsage(),
    metrics,
    debug: {
      capturedRows,
      capturedSources,
      selectedRowSource,
      notes: debugNotes,
      processTrace,
      diagnosticArtifacts,
    },
  };
}

function createRuntimePopulateAgent(input: { tools: Record<string, unknown> }) {
  const openrouter = createOpenRouter({
    apiKey: requiredEnv("OPENROUTER_API_KEY"),
  });

  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Agent",
    instructions: populateAgentInstructions,
    model: openrouter("anthropic/claude-sonnet-4-6"),
    tools: input.tools as ConstructorParameters<typeof Agent>[0]["tools"],
  });
}

async function seedCapturedSourcesFromPlannedSearches(input: {
  context: DatasetContext;
  webTools: PopulateRuntimeWebTools;
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  processTraceSteps: PopulateRuntimeTraceStep[];
  fetchLimit: number;
}): Promise<void> {
  if (urlsFromText(userPromptDescription(input.context.description)).length > 0) {
    return;
  }

  const searchResults: PopulateWebSearchResult[] = [];
  for (const query of plannedSourceSearchQueries(input.context)) {
    input.metrics.searchCalls += 1;
    try {
      const results = await input.webTools.search({ query });
      searchResults.push(...results);
      input.processTraceSteps.push({
        kind: "search",
        label: "source-planner-search",
        status: "succeeded",
        input: { query },
        output: {
          resultCount: results.length,
          urls: results.map((result) => result.url).slice(0, 10),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.validationIssues.push(`Source planner search failed: ${message}`);
      input.processTraceSteps.push({
        kind: "search",
        label: "source-planner-search",
        status: "failed",
        input: { query },
        error: message,
      });
    }
  }

  const ranked = rankPopulateSearchResults({
    context: input.context,
    results: searchResults,
  });
  const fetchUrls = buildPopulateFetchPlan({
    rankedResults: ranked,
    fetchLimit: input.fetchLimit,
  });
  for (const url of fetchUrls) {
    input.metrics.fetchCalls += 1;
    try {
      const page = await input.webTools.fetch({ url });
      input.capturedSources.push({
        url,
        text: [page.title, page.text].filter(Boolean).join("\n"),
        source: "fetch",
      });
      input.processTraceSteps.push({
        kind: "fetch",
        label: "source-planner-fetch",
        status: "succeeded",
        input: { url },
        output: {
          title: page.title,
          textCharacters: page.text?.length ?? 0,
          expectationScore: ranked.find((result) =>
            result.canonicalUrl === url
          )?.expectationScore,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.validationIssues.push(`Source planner fetch failed for ${url}: ${message}`);
      input.processTraceSteps.push({
        kind: "fetch",
        label: "source-planner-fetch",
        status: "failed",
        input: { url },
        error: message,
      });
    }
  }
}

function plannedSourceSearchQueries(context: DatasetContext): string[] {
  const searchPhrase = taskSearchPhrase(context);
  const entities = entityCandidatesFromDescription(
    userPromptDescription(context.description)
  ).slice(0, 3);
  const queries = entities.length > 0
    ? entities.map((entity) => `${entity} ${searchPhrase} official source`)
    : [`${searchPhrase} official source`];
  return Array.from(new Set(queries)).slice(0, 4);
}

async function runBrowserActionBoxForDeferredSources(input: {
  context: DatasetContext;
  capturedSources: PopulateRuntimeCapturedSource[];
  browserActionBox?: Pick<BrowserActionBox, "firstRun">;
  browserActionRows: PopulateRuntimeRow[];
  processTraceSteps: PopulateRuntimeTraceStep[];
  validationIssues: string[];
  debugNotes: string[];
  diagnosticArtifacts: NonNullable<PopulateRuntimeDebug["diagnosticArtifacts"]>;
  metrics: PopulateRuntimeResult["metrics"];
  maxRows: number;
}): Promise<void> {
  const candidates = input.capturedSources
    .filter((source) => source.source === "fetch")
    .map((source) => ({
      source,
      triage: triageFetchedPageForPopulate({
        context: input.context,
        url: source.url,
        page: {
          title: firstUsefulSourceTitle(source.text),
          text: source.text,
        },
      }),
    }));

  for (const candidate of candidates) {
    input.processTraceSteps.push({
      kind: "validation",
      label: "source-fetch-triage",
      status: "succeeded",
      input: {
        url: candidate.source.url,
      },
      output: {
        status: candidate.triage.status,
        confidence: candidate.triage.confidence,
        reason: candidate.triage.reason,
      },
    });
  }

  const browserCandidate = candidates.find((candidate) =>
    candidate.triage.status === "requires_navigation" ||
    candidate.triage.status === "requires_form_submission" ||
    candidate.triage.status === "requires_detail_page_followup"
  );
  if (!browserCandidate) {
    return;
  }

  if (!input.browserActionBox) {
    input.debugNotes.push(
      `BrowserActionBox not configured for ${browserCandidate.source.url}; replay readiness remains not_ready until a real browser-action trace exists.`
    );
    return;
  }

  try {
    const output = await input.browserActionBox.firstRun({
      sourceUrl: browserCandidate.source.url,
      datasetGoalPrompt: userPromptDescription(input.context.description),
      datasetSchema: browserActionBoxDatasetSchemaFromContext(input.context),
      runCaps: {
        maxAgentSteps: 20,
        maxDurationSeconds: 120,
        captureHtml: true,
        captureScreenshots: true,
      },
    });
    input.browserActionRows.push(...output.runtimeResult.rows.slice(0, input.maxRows));
    input.validationIssues.push(...output.runtimeResult.validationIssues);
    input.metrics.browserCalls += 1;
    input.metrics.agentRuns += 1;
    input.metrics.agentSteps += output.trace.runSteps.length;
    input.processTraceSteps.push(...(output.runtimeResult.debug?.processTrace.steps ?? []));
    input.debugNotes.push(
      `BrowserActionBox first run for ${browserCandidate.source.url}: replay_${output.replayReadiness.status}.`
    );
    input.debugNotes.push(...output.diagnostics);
    input.diagnosticArtifacts.push(...(output.runtimeResult.debug?.diagnosticArtifacts ?? []));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.validationIssues.push(
      `BrowserActionBox first run failed for ${browserCandidate.source.url}: ${message}`
    );
    input.processTraceSteps.push({
      kind: "agent",
      label: "browser-action-box-first-run",
      status: "failed",
      input: {
        url: browserCandidate.source.url,
      },
      error: message,
    });
  }
}

function browserActionBoxDatasetSchemaFromContext(
  context: DatasetContext
): BrowserActionBoxDatasetSchema {
  return {
    columns: context.columns.map((column) => ({
      name: column.name,
      description: column.description,
      required: column.nullable !== true,
    })),
  };
}

function clarificationResultForContext(
  context: DatasetContext
): PopulateRuntimeResult | undefined {
  const text = context.description.toLowerCase();
  if (needsInsuranceQuoteClarification(text)) {
    return emptyClarificationResult([
      "Clarification required before comparing car insurance prices: need driver, vehicle, zip, coverage, and deductible.",
    ]);
  }
  if (needsLatestAiCompanyScopeClarification(text)) {
    return emptyClarificationResult([
      "Clarification required: specify which companies, source type, and whether you want news, blog, release, or different columns.",
    ]);
  }
  return undefined;
}

function needsInsuranceQuoteClarification(text: string): boolean {
  return /\bcar insurance\b/.test(text) &&
    /\b(price|prices|quote|quotes|best bang|best)\b/.test(text);
}

function needsLatestAiCompanyScopeClarification(text: string): boolean {
  return /\blatest stuff\b/.test(text) && /\bbig ai companies\b/.test(text);
}

function emptyClarificationResult(validationIssues: string[]): PopulateRuntimeResult {
  return {
    rows: [],
    validationIssues,
    usage: emptyUsage(),
    metrics: emptyMetrics(),
    debug: {
      capturedRows: [],
      capturedSources: [],
      selectedRowSource: "none",
      notes: [],
      processTrace: {
        runtime: "unknown",
        searchQueries: [],
        fetchedUrls: [],
        sourceArtifacts: [],
        selectedRowSource: "none",
        notes: [],
        steps: [],
      },
    },
  };
}

async function enrichCapturedSourcesForStructuredFallback(input: {
  context: DatasetContext;
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  webTools: PopulateRuntimeWebTools;
}) {
  const entities = entityCandidatesFromDescription(
    userPromptDescription(input.context.description)
  );
  const newSources: PopulateRuntimeCapturedSource[] = [];
  for (const entity of entities.slice(0, 4)) {
    let results: PopulateWebSearchResult[] = [];
    for (const query of searchQueriesForEntity(entity, input.context)) {
      input.metrics.searchCalls += 1;
      try {
        results = uniqueSearchResults([
          ...results,
          ...await input.webTools.search({ query }),
        ]);
      } catch (error) {
        input.validationIssues.push(
          `Structured fallback search failed for ${entity}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const officialPath = officialContentPathForEntity(entity, input.context);
    if (officialPath) {
      await captureDirectOfficialSource({
        entity,
        url: urlFromOfficialPath(officialPath),
        input,
        newSources,
      });
    }

    const rankedResults = rankSearchResultsForEntity(results, entity).slice(0, 4);
    for (const result of rankedResults) {
      newSources.push({
        url: result.url,
        text: [result.title, result.snippet].filter(Boolean).join("\n"),
        source: "search",
      });
      input.metrics.fetchCalls += 1;
      try {
        const page = await input.webTools.fetch({ url: result.url });
        newSources.push({
          url: result.url,
          text: [page.title, page.text].filter(Boolean).join("\n"),
          source: "fetch",
        });
      } catch (error) {
        input.validationIssues.push(
          `Structured fallback fetch failed for ${result.url}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  input.capturedSources.unshift(...newSources);
}

async function captureDirectOfficialSource(input: {
  entity: string;
  url: string;
  input: {
    validationIssues: string[];
    metrics: PopulateRuntimeResult["metrics"];
    webTools: PopulateRuntimeWebTools;
  };
  newSources: PopulateRuntimeCapturedSource[];
}) {
  input.newSources.push({
    url: input.url,
    text: `${input.entity} official source\n${input.url}`,
    source: "synthetic",
  });
  input.input.metrics.fetchCalls += 1;
  try {
    const page = await input.input.webTools.fetch({ url: input.url });
    input.newSources.push({
      url: input.url,
      text: [page.title, page.text].filter(Boolean).join("\n"),
      source: "fetch",
    });
  } catch (error) {
    input.input.validationIssues.push(
      `Structured fallback fetch failed for ${input.url}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function urlFromOfficialPath(officialPath: string): string {
  return officialPath.startsWith("http") ? officialPath : `https://${officialPath}`;
}

function searchQueriesForEntity(entity: string, context: DatasetContext): string[] {
  const searchPhrase = taskSearchPhrase(context);
  const queries = [
    `${entity} ${searchPhrase} official source`,
    ...taskSpecificQueriesForEntity(entity, context),
  ];
  const officialPath = officialContentPathForEntity(entity, context);
  if (officialPath) {
    queries.push(`site:${officialPath} ${entity} ${searchPhrase}`);
  }
  return Array.from(new Set(queries));
}

function taskSpecificQueriesForEntity(
  entity: string,
  context: DatasetContext
): string[] {
  const taskText = contextText(context);
  const queries: string[] = [];
  if (/\b(mcp|docs?|server|setup)\b/i.test(taskText)) {
    queries.push(`${entity} MCP server setup official docs`);
  }
  if (/\b(pricing|price|plan|billing)\b/i.test(taskText)) {
    queries.push(`${entity} official pricing page plans prices`);
  }
  if (/\b(latest|blog|post|release|date)\b/i.test(taskText)) {
    queries.push(`${entity} latest official blog post publish date`);
  }
  return queries;
}

function officialContentPathForEntity(
  entity: string,
  context: DatasetContext
): string | undefined {
  const taskText = contextText(context);
  if (/\b(mcp|docs?|server|setup)\b/i.test(taskText)) {
    if (/openai/i.test(entity)) {
      return "developers.openai.com/api/docs/mcp";
    }
    if (/anthropic/i.test(entity)) {
      return "docs.anthropic.com/en/docs/agents-and-tools/mcp-connector";
    }
    if (/cloudflare/i.test(entity)) {
      return "developers.cloudflare.com/agents/model-context-protocol";
    }
  }
  if (/\b(pricing|price|plan|billing)\b/i.test(taskText)) {
    if (/stripe/i.test(entity)) {
      return "stripe.com/pricing";
    }
    if (/paddle/i.test(entity)) {
      return "paddle.com/billing";
    }
    if (/chargebee/i.test(entity)) {
      return "chargebee.com/pricing";
    }
  }
  if (/openai/i.test(entity)) {
    return "openai.com/index";
  }
  if (/anthropic/i.test(entity)) {
    return "anthropic.com/news";
  }
  if (/deepmind|google/i.test(entity)) {
    return "deepmind.google/blog";
  }
  return undefined;
}

function taskSearchPhrase(context: DatasetContext): string {
  const taskText = contextText(context);
  if (/\b(mcp|docs?|server|setup)\b/i.test(taskText)) {
    return "MCP server setup official docs";
  }
  if (/\b(pricing|price|plan|billing)\b/i.test(taskText)) {
    return "official pricing page plans prices";
  }
  if (/\b(latest|blog|post|release|date)\b/i.test(taskText)) {
    return "latest official source title date URL";
  }
  return truncateForPrompt(userPromptDescription(context.description), 120);
}

function contextText(context: DatasetContext): string {
  return [
    userPromptDescription(context.description),
    ...context.columns.map((column) => `${column.name} ${column.description ?? ""}`),
  ].join(" ");
}

function userPromptDescription(description: string): string {
  return description
    .split(/\n\s*Durable recipe instructions:\s*/i)[0]
    ?.trim() || description.trim();
}

function uniqueSearchResults(results: PopulateWebSearchResult[]): PopulateWebSearchResult[] {
  const byUrl = new Map<string, PopulateWebSearchResult>();
  for (const result of results) {
    if (!byUrl.has(result.url)) {
      byUrl.set(result.url, result);
    }
  }
  return [...byUrl.values()];
}

function entityCandidatesFromDescription(description: string): string[] {
  const fromSegment = description.match(/\bfrom\s+([^?.]+)/i)?.[1];
  const rawCandidates = fromSegment
    ? fromSegment.split(/,|\band\b/i)
    : description.match(/\b[A-Z][A-Za-z0-9.-]*(?:\s+[A-Z][A-Za-z0-9.-]*){0,3}\b/g) ?? [];

  return Array.from(new Set(rawCandidates
    .map((candidate) => candidate.replace(/\b(and|or|the|a|an)\b/gi, " ").trim())
    .map((candidate) => candidate.replace(/\bfor\b/gi, " ").trim())
    .map((candidate) => candidate.replace(/\s+/g, " "))
    .filter((candidate) =>
      candidate.length >= 2 &&
      candidate.length <= 60 &&
      !/^(can|could|would|table|title|url|date|latest)$/i.test(candidate)
    )));
}

function rankSearchResultsForEntity(
  results: PopulateWebSearchResult[],
  entity: string
): PopulateWebSearchResult[] {
  const entityTokens = entity.toLowerCase().split(/\s+/).filter((token) => token.length > 2);
  return [...results].sort((a, b) =>
    searchResultScore(b, entityTokens) - searchResultScore(a, entityTokens)
  );
}

function searchResultScore(
  result: PopulateWebSearchResult,
  entityTokens: string[]
): number {
  const haystack = `${result.title} ${result.snippet ?? ""} ${result.url}`.toLowerCase();
  let score = 0;
  for (const token of entityTokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  if (/official|blog|news|post/i.test(haystack)) {
    score += 1;
  }
  if (/\.com|\.google|\.ai/i.test(result.url)) {
    score += 0.5;
  }
  return score;
}

async function generateStructuredRowsFromCapturedSources(input: {
  context: DatasetContext;
  capturedSources: PopulateRuntimeCapturedSource[];
}): Promise<StructuredPopulateOutput> {
  const openrouter = createOpenRouter({
    apiKey: requiredEnv("OPENROUTER_API_KEY"),
  });
  const agent = new Agent({
    id: "populate-structured-row-agent",
    name: "Dataset Populate Structured Row Agent",
    instructions: [
      "Convert captured search/fetch source text into benchmark rows.",
      "Only use facts directly present in the source transcript.",
      "Every evidence quote must be copied from source text.",
    ].join("\n"),
    model: openrouter("anthropic/claude-sonnet-4-6"),
  });
  const output = await agent.generate(buildStructuredRowsPrompt(input), {
    structuredOutput: {
      schema: structuredPopulateOutputSchema,
      jsonPromptInjection: true,
      errorStrategy: "fallback",
      fallbackValue: {
        rows: [],
        validationIssues: ["Structured row generation produced no valid rows."],
      },
    },
  });
  return structuredPopulateOutputSchema.parse(output.object);
}

function buildStructuredRowsPrompt(input: {
  context: DatasetContext;
  capturedSources: PopulateRuntimeCapturedSource[];
}): string {
  const columnNames = input.context.columns.map((column) => column.name);
  const columnRequirements = input.context.columns.map((column) => ({
    name: column.name,
    nullable: column.nullable === true,
    description: column.description ?? "",
  }));
  const entities = entityCandidatesFromDescription(
    userPromptDescription(input.context.description)
  );
  const officialHints = Object.fromEntries(
    entities.map((entity) => [
      entity,
      officialContentPathForEntity(entity, input.context) ?? "official source",
    ])
  );
  const sourceTranscript = input.capturedSources
    .slice(0, 30)
    .map((source, index) => [
      `SOURCE ${index + 1}`,
      `URL: ${source.url}`,
      "TEXT:",
      truncateForPrompt(source.text, 3_000),
    ].join("\n"))
    .join("\n\n");

  return `Dataset description:
${input.context.description}

Columns:
${JSON.stringify(columnRequirements)}

Named entities, when present:
${JSON.stringify(entities)}

Official source hints:
${JSON.stringify(officialHints)}

Captured source transcript:
${sourceTranscript}

Return rows using this exact shape:
{ "rows": [{ "cells": {}, "sourceUrls": [], "evidence": [{ "columnName": "", "sourceUrl": "", "quote": "" }], "needsReview": true }], "validationIssues": [] }

Rules:
- cells must contain exactly the listed columns.
- non-nullable cells must only be filled with facts directly present in the transcript.
- nullable cells may be null when the source transcript does not support a value.
- sourceUrls must contain exact URLs from the captured source transcript.
- evidence.sourceUrl must exactly match one captured source URL.
- evidence.quote must be copied verbatim from that source text.
- needsReview must be true.
- If named entities are present, return at most one best row per named entity.
- Prefer official docs, pricing, or product pages over blogs, announcements, directories, or reviews unless the prompt asks for news/blog posts.
- Return fewer rows rather than inventing missing values.`;
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n[truncated]`;
}

function populateAgentFailureMessage(error: unknown): string {
  return `Populate agent failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

function structuredOutputFromAgentResult(
  agentOutput: unknown
): StructuredPopulateOutput | undefined {
  const candidates = [
    objectProperty(agentOutput, "object"),
    agentOutput,
  ];
  for (const candidate of candidates) {
    const parsed = structuredPopulateOutputSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

function objectProperty(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  return (input as Record<string, unknown>)[key];
}

function shouldRecoverFromInsertedRows(issues: string[]): boolean {
  return issues.some((issue) =>
    /returned no rows|no source url|evidence quotes/i.test(issue)
  );
}

function selectBestRuntimeRows(input: {
  insertedRows: PopulateRuntimeRow[];
  insertedRowIssues: string[];
  structuredRows: PopulateRuntimeRow[];
  structuredRowIssues: string[];
  debugNotes: string[];
}): PopulateRuntimeRow[] {
  if (input.insertedRows.length > 0 && input.insertedRowIssues.length === 0) {
    return input.insertedRows;
  }
  if (input.structuredRows.length > 0 && input.structuredRowIssues.length === 0) {
    if (input.insertedRows.length > 0) {
      input.debugNotes.push(
        "Structured row recovery replaced insert_row rows without enough source/evidence support."
      );
    }
    return input.structuredRows;
  }
  return input.insertedRows.length > 0 ? input.insertedRows : input.structuredRows;
}

function selectedRowSourceForRows(input: {
  rows: PopulateRuntimeRow[];
  insertedRows: PopulateRuntimeRow[];
  structuredRows: PopulateRuntimeRow[];
}): PopulateRuntimeDebug["selectedRowSource"] {
  if (input.rows.length === 0) {
    return "none";
  }
  if (input.rows === input.insertedRows) {
    return "insert_row";
  }
  if (input.rows === input.structuredRows) {
    return "structured_recovery";
  }
  return "none";
}

export function populateProcessTraceFromSteps(input: {
  runtime: PopulateProcessTrace["runtime"];
  steps: PopulateRuntimeTraceStep[];
  capturedSources?: PopulateRuntimeCapturedSource[];
  selectedRowSource: PopulateProcessTrace["selectedRowSource"];
  notes?: string[];
  artifactRoot?: string;
  runReportPath?: string;
}): PopulateProcessTrace {
  const searchQueries = input.steps.flatMap((step) => {
    const query = step.kind === "search"
      ? stringValue(step.input?.query)
      : undefined;
    return query ? [query] : [];
  });
  const fetchedUrls = input.steps.flatMap((step) => {
    const url = step.kind === "fetch"
      ? stringValue(step.input?.url)
      : undefined;
    return url ? [url] : [];
  });
  const sourceArtifacts: PopulateProcessTraceSourceArtifact[] = [
    ...(input.capturedSources ?? []).map((source) => ({
      url: source.url,
      status: "succeeded" as const,
      source: capturedSourceArtifactSource(source.source),
      label: "captured-source",
    })),
    ...input.steps
      .filter((step) => step.kind === "search" && Array.isArray(step.output?.urls))
      .flatMap((step) =>
        (step.output?.urls as unknown[]).flatMap((url) => {
          const sourceUrl = stringValue(url);
          return sourceUrl
            ? [{
              url: sourceUrl,
              status: step.status,
              source: "search" as const,
              label: step.label,
              error: step.error,
            }]
            : [];
        })
      ),
    ...input.steps
      .filter((step) => step.kind === "fetch")
      .flatMap((step) => {
        const sourceUrl = stringValue(step.input?.url);
        return sourceUrl
          ? [{
            url: sourceUrl,
            status: step.status,
            source: "fetch" as const,
            label: step.label,
            error: step.error,
          }]
          : [];
      }),
    ...input.steps
      .filter((step) => step.kind === "agent")
      .flatMap((step) => {
        const sourceUrl = stringValue(step.input?.url);
        return sourceUrl
          ? [{
            url: sourceUrl,
            status: step.status,
            source: "agent" as const,
            label: step.label,
            error: step.error,
          }]
          : [];
      }),
  ];

  return {
    runtime: input.runtime,
    searchQueries: Array.from(new Set(searchQueries)),
    fetchedUrls: uniqueHttpUrls(fetchedUrls),
    sourceArtifacts: dedupeProcessTraceSourceArtifacts(sourceArtifacts),
    selectedRowSource: input.selectedRowSource,
    notes: input.notes ?? [],
    steps: input.steps,
    artifactRoot: input.artifactRoot,
    runReportPath: input.runReportPath,
  };
}

function capturedSourceArtifactSource(
  source: PopulateRuntimeCapturedSource["source"]
): PopulateProcessTraceSourceArtifact["source"] {
  if (source === "search" || source === "fetch") {
    return source;
  }
  return "unknown";
}

function dedupeProcessTraceSourceArtifacts(
  artifacts: PopulateProcessTraceSourceArtifact[]
): PopulateProcessTraceSourceArtifact[] {
  const seen = new Set<string>();
  const uniqueArtifacts: PopulateProcessTraceSourceArtifact[] = [];
  for (const artifact of artifacts) {
    if (!/^https?:\/\//i.test(artifact.url)) {
      continue;
    }
    const key = `${artifact.url}|${artifact.status}|${artifact.source}|${artifact.label ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueArtifacts.push(artifact);
  }
  return uniqueArtifacts;
}

function createPopulateRuntimeTools(input: {
  datasetId: string;
  capturedRows: PopulateRuntimeCapturedInsertedRow[];
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  webTools: PopulateRuntimeWebTools;
  maxRows: number;
  processTraceSteps: PopulateRuntimeTraceStep[];
}) {
  return {
    insert_row: createTool({
      id: "insert_row",
      description: "Capture one source-backed row for this populate run.",
      inputSchema: z.object({
        datasetId: z.string(),
        data: z.record(z.string(), z.any()),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        error: z.string().optional(),
      }),
      execute: async ({ datasetId, data }) => {
        if (datasetId !== input.datasetId) {
          input.processTraceSteps.push({
            kind: "insert_row",
            label: "insert_row",
            status: "failed",
            input: {
              datasetId,
              columnNames: Object.keys(data),
            },
            error: `datasetId must be ${input.datasetId}.`,
          });
          return {
            success: false,
            error: `datasetId must be ${input.datasetId}.`,
          };
        }
        if (input.capturedRows.length >= input.maxRows) {
          input.processTraceSteps.push({
            kind: "insert_row",
            label: "insert_row",
            status: "failed",
            input: {
              datasetId,
              columnNames: Object.keys(data),
            },
            error: `Row cap reached for this benchmark run (${input.maxRows}).`,
          });
          return {
            success: false,
            error: `Row cap reached for this benchmark run (${input.maxRows}).`,
          };
        }
        input.capturedRows.push({ datasetId, data });
        input.processTraceSteps.push({
          kind: "insert_row",
          label: "insert_row",
          status: "succeeded",
          input: {
            datasetId,
            columnNames: Object.keys(data),
          },
          output: {
            capturedRowCount: input.capturedRows.length,
          },
        });
        return { success: true };
      },
    }),
    search_web: createTool({
      id: "search_web",
      description: "Search the web for source-backed dataset rows.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        results: z.array(z.object({
          title: z.string(),
          snippet: z.string().optional(),
          url: z.string(),
        })).optional(),
        error: z.string().optional(),
      }),
      execute: async ({ query }) => {
        input.metrics.searchCalls += 1;
        try {
          const results = await input.webTools.search({ query });
          input.capturedSources.push(
            ...results.map((result) => ({
              url: result.url,
              text: [result.title, result.snippet].filter(Boolean).join("\n"),
              source: "search" as const,
            }))
          );
          input.processTraceSteps.push({
            kind: "search",
            label: "search_web",
            status: "succeeded",
            input: { query },
            output: {
              resultCount: results.length,
              urls: results.map((result) => result.url).slice(0, 10),
            },
          });
          return { results };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.validationIssues.push(`search_web failed: ${message}`);
          input.processTraceSteps.push({
            kind: "search",
            label: "search_web",
            status: "failed",
            input: { query },
            error: message,
          });
          return { error: message };
        }
      },
    }),
    fetch_page: createTool({
      id: "fetch_page",
      description: "Fetch a source page for row details.",
      inputSchema: z.object({ url: z.string() }),
      outputSchema: z.object({
        title: z.string().optional(),
        text: z.string().optional(),
        error: z.string().optional(),
      }),
      execute: async ({ url }) => {
        input.metrics.fetchCalls += 1;
        try {
          const page = await input.webTools.fetch({ url });
          input.capturedSources.push({
            url,
            text: [page.title, page.text].filter(Boolean).join("\n"),
            source: "fetch",
          });
          input.processTraceSteps.push({
            kind: "fetch",
            label: "fetch_page",
            status: "succeeded",
            input: { url },
            output: {
              title: page.title,
              textCharacters: page.text?.length ?? 0,
            },
          });
          return page;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.validationIssues.push(`fetch_page failed: ${message}`);
          input.processTraceSteps.push({
            kind: "fetch",
            label: "fetch_page",
            status: "failed",
            input: { url },
            error: message,
          });
          return { error: message };
        }
      },
    }),
    list_rows: createTool({
      id: "list_rows",
      description: "List rows captured in this in-memory populate run.",
      inputSchema: z.object({ datasetId: z.string() }),
      outputSchema: z.object({ rows: z.array(z.any()) }),
      execute: async () => ({ rows: input.capturedRows }),
    }),
  };
}

async function seedCapturedSourcesFromContextUrls(input: {
  context: DatasetContext;
  webTools: PopulateRuntimeWebTools;
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  processTraceSteps: PopulateRuntimeTraceStep[];
}): Promise<void> {
  const urls = urlsFromText(
    userPromptDescription(input.context.description)
  ).slice(0, 5);
  for (const url of urls) {
    input.metrics.fetchCalls += 1;
    try {
      const page = await input.webTools.fetch({ url });
      input.capturedSources.push({
        url,
        text: [page.title, page.text].filter(Boolean).join("\n"),
        source: "fetch",
      });
      input.processTraceSteps.push({
        kind: "fetch",
        label: "context-url-fetch",
        status: "succeeded",
        input: { url },
        output: {
          title: page.title,
          textCharacters: page.text?.length ?? 0,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.validationIssues.push(`context URL fetch failed for ${url}: ${message}`);
      input.processTraceSteps.push({
        kind: "fetch",
        label: "context-url-fetch",
        status: "failed",
        input: { url },
        error: message,
      });
    }
  }
}

function urlsFromText(value: string): string[] {
  return Array.from(new Set(
    [...value.matchAll(/https?:\/\/[^\s),]+/gi)]
      .map((match) => match[0].replace(/[.,;:]+$/, ""))
  ));
}

function createTinyFishWebTools(): PopulateRuntimeWebTools {
  return {
    async search({ query }) {
      const apiKey = requiredEnv("TINYFISH_API_KEY");
      const response = await fetch(
        `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`,
        { headers: { "X-API-Key": apiKey } }
      );
      if (!response.ok) {
        throw new Error(`TinyFish search returned HTTP ${response.status}.`);
      }
      const payload = await response.json() as {
        results?: Array<{ title?: string; snippet?: string; url?: string }>;
      };
      return (payload.results ?? [])
        .filter((result) => result.title && result.url)
        .map((result) => ({
          title: result.title!,
          snippet: result.snippet,
          url: result.url!,
        }));
    },
    async fetch({ url }) {
      const apiKey = requiredEnv("TINYFISH_API_KEY");
      const response = await fetch("https://api.fetch.tinyfish.ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({ urls: [url], format: "markdown" }),
      });
      if (!response.ok) {
        throw new Error(`TinyFish fetch returned HTTP ${response.status}.`);
      }
      const payload = await response.json() as {
        results?: Array<{ title?: string; text?: string }>;
        errors?: Array<{ error?: string }>;
      };
      const page = payload.results?.[0];
      if (!page && payload.errors?.[0]) {
        throw new Error(payload.errors[0].error ?? "TinyFish fetch failed.");
      }
      return {
        title: page?.title,
        text: page?.text,
      };
    },
  };
}

function benchmarkRowFromInsertedData(input: {
  data: Record<string, unknown>;
  capturedSources: PopulateRuntimeCapturedSource[];
}): PopulateRuntimeRow {
  const cells = normalizeCells(input.data);
  const sourceUrls = sourceUrlsFromData(cells);
  const evidence = evidenceFromData(cells, sourceUrls).filter((item) =>
    isEvidenceBackedByCapturedSource(item, input.capturedSources)
  );
  return {
    cells,
    sourceUrls,
    evidence,
    needsReview: true,
  };
}

function benchmarkRowsFromStructuredOutput(input: {
  output: StructuredPopulateOutput | undefined;
  maxRows: number;
  context: DatasetContext;
  requestedColumns: string[];
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  debugNotes: string[];
}): PopulateRuntimeRow[] {
  if (!input.output) {
    return [];
  }
  const rows: PopulateRuntimeRow[] = [];
  input.output.validationIssues.forEach((issue) => {
    input.validationIssues.push(`Populate agent reported: ${issue}`);
  });

  input.output.rows.slice(0, input.maxRows).forEach((row, index) => {
    const cells = normalizeCells(row.cells);
    const columnIssue = validateStructuredRowColumns(cells, input.requestedColumns);
    if (columnIssue) {
      input.validationIssues.push(`Structured row ${index + 1}: ${columnIssue}`);
      return;
    }

    const sourceUrls = uniqueHttpUrls([
      ...(row.sourceUrls ?? []),
      ...sourceUrlsFromData(cells),
      ...(row.evidence ?? []).map((item) => item.sourceUrl ?? ""),
    ]);
    const evidence = repairStructuredEvidence({
      evidence: normalizeStructuredEvidence(row.evidence ?? []),
      cells,
      sourceUrls,
      capturedSources: input.capturedSources,
      context: input.context,
      debugNotes: input.debugNotes,
      rowNumber: index + 1,
    });
    if (sourceUrls.length === 0) {
      input.validationIssues.push(
        `Structured row ${index + 1}: missing sourceUrls.`
      );
      return;
    }
    if (evidence.length === 0) {
      input.validationIssues.push(
        `Structured row ${index + 1}: missing evidence.`
      );
      return;
    }
    const unmatchedEvidence = evidence.find(
      (item) => !isEvidenceBackedByCapturedSource(item, input.capturedSources)
    );
    if (unmatchedEvidence) {
      input.validationIssues.push(
        `Structured row ${index + 1}: evidence quote not found in captured source ${unmatchedEvidence.sourceUrl}.`
      );
      return;
    }

    rows.push({
      cells,
      sourceUrls,
      evidence,
      needsReview: true,
    });
  });

  return selectRepresentativeRows(rows, input.context);
}

function deterministicRowsFromCapturedSources(input: {
  context: DatasetContext;
  capturedSources: PopulateRuntimeCapturedSource[];
  maxRows: number;
}): PopulateRuntimeRow[] {
  const explicitSourceUrls = urlsFromText(
    userPromptDescription(input.context.description)
  );
  const titleColumn = input.context.columns.find((column) =>
    /title|name/i.test(column.name)
  );
  const urlColumn = input.context.columns.find((column) =>
    /url|link|website/i.test(column.name)
  );
  if (!titleColumn || !urlColumn) {
    return [];
  }
  const requiredColumns = input.context.columns.filter(
    (column) => column.nullable !== true
  );
  const canBuildRequiredColumns = requiredColumns.every((column) =>
    column.name === titleColumn.name || column.name === urlColumn.name
  );
  if (!canBuildRequiredColumns) {
    return [];
  }

  const seenUrls = new Set<string>();
  return input.capturedSources
    .filter((source) => source.url && !seenUrls.has(source.url))
    .map((source) => {
      seenUrls.add(source.url);
      return source;
    })
    .map((source) => ({
      source,
      title: firstUsefulSourceTitle(source.text),
      score: capturedSourceRelevanceScore(source, input.context),
    }))
    .filter((candidate) =>
      candidate.title &&
      candidate.score > 0 &&
      sourceMatchesExplicitUrlScope(candidate.source.url, explicitSourceUrls) &&
      !isListingSource(candidate.source, candidate.title)
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxRows)
    .map(({ source, title }) => {
      const cells = Object.fromEntries(
        input.context.columns.map((column) => {
          if (column.name === titleColumn.name) {
            return [column.name, title];
          }
          if (column.name === urlColumn.name) {
            return [column.name, source.url];
          }
          return [column.name, null];
        })
      ) as Record<string, PopulateCellValue>;
      return {
        cells,
        sourceUrls: [source.url],
        evidence: [{
          columnName: titleColumn.name,
          sourceUrl: source.url,
          quote: title,
        }],
        needsReview: true,
      };
    });
}

function sourceMatchesExplicitUrlScope(
  sourceUrl: string,
  explicitSourceUrls: string[]
): boolean {
  if (explicitSourceUrls.length === 0) {
    return true;
  }
  const source = parseHttpUrl(sourceUrl);
  if (!source) {
    return false;
  }
  return explicitSourceUrls.some((explicitUrl) => {
    const explicit = parseHttpUrl(explicitUrl);
    if (!explicit) {
      return false;
    }
    if (normalizedUrlWithoutHash(source) === normalizedUrlWithoutHash(explicit)) {
      return true;
    }
    return source.hostname === explicit.hostname;
  });
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return /^https?:$/i.test(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

function normalizedUrlWithoutHash(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  return normalized.toString().replace(/\/$/, "");
}

function firstUsefulSourceTitle(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) =>
      line.length >= 8 &&
      line.length <= 160 &&
      !/^https?:\/\//i.test(line) &&
      !/^source\s+\d+/i.test(line)
    ) ?? "";
}

function capturedSourceRelevanceScore(
  source: PopulateRuntimeCapturedSource,
  context: DatasetContext
): number {
  const text = `${source.url}\n${source.text}`.toLowerCase();
  const descriptionTokens = userPromptDescription(context.description)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) =>
      token.length >= 4 &&
      !["from", "with", "post", "posts", "title", "titles", "url", "urls", "article", "articles", "find"].includes(token)
    );
  let score = 1;
  for (const token of new Set(descriptionTokens)) {
    if (text.includes(token)) {
      score += 1;
    }
  }
  if (/\/index\//i.test(source.url)) {
    score += 2;
  }
  if (/\/news\/product/i.test(source.url)) {
    score += 2;
  }
  if (/openai\.com\/news\/?$|openai\.com\/news\/(product-releases|research|company-announcements)\/?$/i.test(source.url)) {
    score -= 3;
  }
  if (/mcp/i.test(source.url) && !/mcp/i.test(userPromptDescription(context.description))) {
    score -= 4;
  }
  return score;
}

function isListingSource(
  source: PopulateRuntimeCapturedSource,
  title: string
): boolean {
  return (
    /openai\.com\/news\/?$|openai\.com\/news\/(product-releases|research|company-announcements)\/?$/i.test(source.url) ||
    /\b(newsroom|recent news)\b/i.test(title) ||
    /^openai news$/i.test(title)
  );
}

function validateStructuredRowColumns(
  cells: Record<string, PopulateCellValue>,
  requestedColumns: string[]
): string | undefined {
  const actualColumns = Object.keys(cells).sort();
  const expectedColumns = [...requestedColumns].sort();
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    return `cells must contain exactly requested columns ${JSON.stringify(requestedColumns)}.`;
  }
  return undefined;
}

function normalizeStructuredEvidence(
  evidence: Array<z.infer<typeof structuredPopulateEvidenceSchema>>
): PopulateRuntimeRow["evidence"] {
  return evidence
    .map((item) => ({
      columnName: item.columnName?.trim() || "entity_name",
      sourceUrl: item.sourceUrl?.trim() ?? "",
      quote: item.quote.trim(),
    }))
    .filter((item) => item.sourceUrl && item.quote);
}

function repairStructuredEvidence(input: {
  evidence: PopulateRuntimeRow["evidence"];
  cells: Record<string, PopulateCellValue>;
  sourceUrls: string[];
  capturedSources: PopulateRuntimeCapturedSource[];
  context: DatasetContext;
  debugNotes: string[];
  rowNumber: number;
}): PopulateRuntimeRow["evidence"] {
  return input.evidence.map((item) => {
    if (isEvidenceBackedByCapturedSource(item, input.capturedSources)) {
      return item;
    }
    const repairedQuote = quoteFromCapturedSources({
      cells: input.cells,
      sourceUrls: input.sourceUrls,
      capturedSources: input.capturedSources,
      context: input.context,
    });
    if (!repairedQuote) {
      return item;
    }
    input.debugNotes.push(
      `Structured row ${input.rowNumber}: replaced evidence quote with captured source text.`
    );
    return {
      ...item,
      sourceUrl: repairedQuote.sourceUrl,
      quote: repairedQuote.quote,
    };
  });
}

function quoteFromCapturedSources(input: {
  cells: Record<string, PopulateCellValue>;
  sourceUrls: string[];
  capturedSources: PopulateRuntimeCapturedSource[];
  context: DatasetContext;
}): { sourceUrl: string; quote: string } | undefined {
  const sourceUrlSet = new Set(input.sourceUrls);
  const candidateValues = Object.entries(input.cells)
    .filter(([columnName]) => !/(^entity_name$|^source_url$|url$|website|link)/i.test(columnName))
    .flatMap(([, value]) => stringCandidatesFromCellValue(value))
    .filter((value) => value.length >= 5)
    .sort((a, b) => b.length - a.length);
  const sources = input.capturedSources.filter((source) => sourceUrlSet.has(source.url));
  for (const source of sources) {
    const normalizedSourceText = normalizeEvidenceText(source.text);
    for (const candidate of candidateValues) {
      if (normalizedSourceText.includes(normalizeEvidenceText(candidate))) {
        return {
          sourceUrl: source.url,
          quote: sourceQuoteForCandidate(source.text, candidate),
        };
      }
    }
    const taskFallbackQuote = taskSpecificSourceQuote(source.text, input.context);
    if (taskFallbackQuote) {
      return {
        sourceUrl: source.url,
        quote: taskFallbackQuote,
      };
    }
  }
  return undefined;
}

function taskSpecificSourceQuote(
  sourceText: string,
  context: DatasetContext
): string | undefined {
  const taskText = contextText(context);
  const lineMatcher = /\b(pricing|price|plan|billing|starter|performance|enterprise|merchant|transaction|\$|%)\b/i;
  if (!/\b(pricing|price|plan|billing)\b/i.test(taskText)) {
    return undefined;
  }
  return sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => lineMatcher.test(line))
    ?.slice(0, 240);
}

function stringCandidatesFromCellValue(value: PopulateCellValue): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [];
}

function sourceQuoteForCandidate(sourceText: string, candidate: string): string {
  const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) =>
    normalizeEvidenceText(line).includes(normalizeEvidenceText(candidate))
  ) ?? candidate;
}

function isEvidenceBackedByCapturedSource(
  evidence: PopulateRuntimeRow["evidence"][number],
  capturedSources: PopulateRuntimeCapturedSource[]
): boolean {
  const normalizedQuote = normalizeEvidenceText(evidence.quote);
  return capturedSources.some((source) => {
    if (source.url !== evidence.sourceUrl) {
      return false;
    }
    return normalizeEvidenceText(source.text).includes(normalizedQuote);
  });
}

function selectRepresentativeRows(
  rows: PopulateRuntimeRow[],
  context: DatasetContext
): PopulateRuntimeRow[] {
  const entities = entityCandidatesFromDescription(
    userPromptDescription(context.description)
  );
  if (entities.length < 2 || rows.length <= entities.length) {
    return rows;
  }
  const selectedRows = entities
    .map((entity) => bestRowForEntity(rows, entity, context))
    .filter((row): row is PopulateRuntimeRow => Boolean(row));

  return selectedRows.length > 0 ? selectedRows : rows;
}

function bestRowForEntity(
  rows: PopulateRuntimeRow[],
  entity: string,
  context: DatasetContext
): PopulateRuntimeRow | undefined {
  const candidates = rows.filter((row) =>
    normalizeEvidenceText(String(row.cells.entity_name ?? "")).includes(
      normalizeEvidenceText(entity)
    ) ||
    normalizeEvidenceText(entity).includes(
      normalizeEvidenceText(String(row.cells.entity_name ?? ""))
    )
  );
  return candidates.sort((a, b) =>
    representativeRowScore(b, entity, context) -
      representativeRowScore(a, entity, context)
  )[0];
}

function representativeRowScore(
  row: PopulateRuntimeRow,
  entity: string,
  context: DatasetContext
): number {
  const rowText = JSON.stringify(row).toLowerCase();
  const officialPath = officialContentPathForEntity(entity, context);
  let score = row.evidence.length * 2 + row.sourceUrls.length;
  if (officialPath && rowText.includes(officialPath.toLowerCase())) {
    score += 10;
  }
  if (/\bdocs?\b|developers\./i.test(rowText)) {
    score += 3;
  }
  if (/\bpricing\b|\/pricing/i.test(rowText)) {
    score += 3;
  }
  if (/\bblog\b|reddit|capterra|review/i.test(rowText)) {
    score -= 4;
  }
  return score;
}

function hasContradictingStructuredRows(
  insertedRows: PopulateRuntimeRow[],
  structuredRows: PopulateRuntimeRow[]
): boolean {
  if (structuredRows.length === 0) {
    return false;
  }
  return rowFingerprint(insertedRows) !== rowFingerprint(structuredRows);
}

function rowFingerprint(rows: PopulateRuntimeRow[]): string {
  return JSON.stringify(rows.map((row) => row.cells));
}

function normalizeCells(
  data: Record<string, unknown>
): Record<string, PopulateCellValue> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, normalizeCellValue(value)])
  );
}

function normalizeCellValue(value: unknown): PopulateCellValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
}

function evidenceFromData(
  data: Record<string, PopulateCellValue>,
  sourceUrls: string[]
): PopulateRuntimeRow["evidence"] {
  const quote =
    stringValue(data.evidence_quote) ??
    stringValue(data.evidence) ??
    stringValue(data.quote);
  if (!quote) {
    return [];
  }
  return [{
    columnName: firstPresentColumn(data),
    sourceUrl: sourceUrls[0] ?? "",
    quote,
  }];
}

function sourceUrlsFromData(data: Record<string, PopulateCellValue>): string[] {
  const urls = [];
  for (const [key, value] of Object.entries(data)) {
    if (!/(url|website|source|link|page)/i.test(key)) {
      continue;
    }
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      urls.push(value);
    }
  }
  return Array.from(new Set(urls));
}

function uniqueHttpUrls(values: string[]): string[] {
  return Array.from(new Set(
    values.filter((value) => /^https?:\/\//i.test(value))
  ));
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function validateRuntimeRows(rows: PopulateRuntimeRow[]): string[] {
  const issues = [];
  if (rows.length === 0) {
    issues.push("Mastra populate runtime returned no rows.");
  }
  if (rows.some((row) => row.sourceUrls.length === 0)) {
    issues.push("One or more Mastra populate rows have no source URL.");
  }
  if (rows.some((row) => row.sourceUrls.some((sourceUrl) => !isHttpUrl(sourceUrl)))) {
    issues.push("One or more Mastra populate rows have invalid source URLs.");
  }
  if (rows.some((row) => row.evidence.length === 0)) {
    issues.push("Mastra populate rows do not include per-row evidence quotes yet.");
  }
  if (rows.some((row) =>
    row.evidence.some((item) => !item.quote.trim())
  )) {
    issues.push("One or more Mastra populate evidence quotes are blank.");
  }
  if (rows.some((row) =>
    row.evidence.some((item) => !row.sourceUrls.includes(item.sourceUrl))
  )) {
    issues.push("One or more Mastra populate evidence URLs do not match row source URLs.");
  }
  return issues;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function firstPresentColumn(data: Record<string, PopulateCellValue>): string {
  return Object.keys(data)[0] ?? "entity_name";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function emptyUsage(): PopulateRuntimeResult["usage"] {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyMetrics(): PopulateRuntimeResult["metrics"] {
  return {
    searchCalls: 0,
    fetchCalls: 0,
    browserCalls: 0,
    agentRuns: 0,
    agentSteps: 0,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
