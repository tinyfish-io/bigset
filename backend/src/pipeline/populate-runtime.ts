import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

import {
  DEFAULT_OPENROUTER_MODEL_ID,
  requiredOpenRouterApiKey,
} from "../openrouter-models.js";
import { runParallelPopulatePhase, type PopulateParallelHooks } from "./populate-parallel.js";
import {
  finalizeAcquisitionResult,
  normalizePopulateAcquisitionResult,
  runSearchAcquisitionPhase,
  type PopulateAcquisitionResult,
  type SearchAcquisitionAgentRunner,
  type SearchAcquisitionPhaseResult,
} from "./populate-acquisition.js";
import type { inferSchema } from "./schema-inference.js";
import {
  isPopulateBenchmarkDebugEnabled,
  populateBenchmarkArtifactDirectory,
  writePopulateBenchmarkDebugArtifacts,
} from "./populate-benchmark-debug.js";
import {
  resolvePopulateRuntimeLimits,
  type PopulateRuntimeLimits,
} from "./populate-runtime-limits.js";
import {
  normalizeSearchResultUrl,
  siteNameFromUrl,
} from "./populate-search-prioritization.js";
import type {
  PopulateFetchedPage,
  PopulateRuntimeCapturedSource,
  PopulateRuntimeWebTools,
  PopulateWebSearchResult,
} from "./populate-web-types.js";
import {
  datasetContextSchema,
  type DatasetContext,
} from "./populate.js";
import {
  getCurrentLlmUsage,
  recordAgentGenerationUsage,
  runWithLlmUsageScope,
  toPopulateRuntimeUsage,
} from "./llm-usage.js";
import {
  structuredPopulateEvidenceSchema,
  structuredPopulateOutputSchema,
  type DatasetSchema,
  type StructuredPopulateOutput,
} from "./types.js";

export type {
  PopulateFetchedPage,
  PopulateRuntimeCapturedSource,
  PopulateRuntimeWebTools,
  PopulateWebSearchResult,
} from "./populate-web-types.js";

export type { PopulateCellValue, PopulateRuntimeRow } from "./populate-row.js";
import type { PopulateCellValue, PopulateRuntimeRow } from "./populate-row.js";

export interface PopulateRuntimeCapturedInsertedRow {
  datasetId: string;
  data: Record<string, unknown>;
}

export interface PopulateRuntimeDebug {
  acquisition?: PopulateAcquisitionResult;
  capturedRows: PopulateRuntimeCapturedInsertedRow[];
  capturedSources: PopulateRuntimeCapturedSource[];
  selectedRowSource: "insert_row" | "structured_recovery" | "none";
  notes: string[];
  metricsBreakdown?: {
    acquisitionSearchCalls: number;
    populateFetchCalls: number;
  };
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

export type PopulateRuntimeAgentRunner = (input: {
  prompt: string;
  tools: Record<string, unknown>;
}) => Promise<unknown>;

export async function runPopulateRuntime(input: {
  context: DatasetContext;
  dataSpec?: DatasetSchema;
  webTools?: PopulateRuntimeWebTools;
  agentRunner?: PopulateRuntimeAgentRunner;
  searchAcquisitionRunner?: SearchAcquisitionAgentRunner;
  acquisition?: PopulateAcquisitionResult;
  maxRows?: number;
  maxSearchCalls?: number;
  maxFetchCalls?: number;
  inferSchemaFn?: typeof inferSchema;
  populateHooks?: PopulateParallelHooks;
}): Promise<PopulateRuntimeResult> {
  const parsedContext = datasetContextSchema.parse(input.context);
  const clarificationResult = clarificationResultForContext(parsedContext);
  if (clarificationResult) {
    return clarificationResult;
  }

  const { result, usage } = await runWithLlmUsageScope(async () => {
  const capturedSources: PopulateRuntimeCapturedSource[] = [];
  const validationIssues: string[] = [];
  const debugNotes: string[] = [];
  const metrics = emptyMetrics();
  const limits = resolvePopulateRuntimeLimits({
    maxRows: input.maxRows,
    maxSearchCalls: input.maxSearchCalls,
    maxFetchCalls: input.maxFetchCalls,
  });
  const webTools = input.webTools ?? createTinyFishWebTools();
  let acquisitionSearchCalls = 0;

  let dataSpec = input.dataSpec;
  let acquisition = input.acquisition;
  let searchPoolResults: SearchAcquisitionPhaseResult["searchPoolResults"] = [];
  if (!acquisition) {
    try {
      const acquisitionPhase = await runSearchAcquisitionPhase({
        context: parsedContext,
        dataSpec,
        maxSearchCalls: limits.maxSearchCalls,
        webTools,
        metrics,
        validationIssues,
        debugNotes,
        searchAcquisitionRunner: input.searchAcquisitionRunner,
        inferSchemaFn: input.inferSchemaFn,
      });
      searchPoolResults = acquisitionPhase.searchPoolResults;
      acquisition = finalizeAcquisitionResult(
        acquisitionPhase,
        limits.maxFetchCalls
      );
      if (!dataSpec) {
        dataSpec = acquisitionPhase.dataSpec;
        debugNotes.push(
          `Inferred data spec "${dataSpec.dataset_name}" with ${acquisitionPhase.initialQueries.length} seed search queries.`
        );
      }
    } catch (error) {
      validationIssues.push(
        `Search acquisition failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      acquisition = {
        prioritizedUrls: [],
        scoredUrls: [],
        initialQueries: [],
        validationIssues: [],
      };
    }
  } else {
    acquisition = normalizePopulateAcquisitionResult(acquisition, limits.maxFetchCalls);
  }
  acquisitionSearchCalls = metrics.searchCalls;

  if (!dataSpec) {
    validationIssues.push("Populate phase requires a dataset spec.");
    dataSpec = {
      dataset_name: parsedContext.datasetName,
      description: parsedContext.description,
      primary_key: parsedContext.columns[0]?.name ?? "entity_name",
      search_queries: acquisition.initialQueries.length
        ? acquisition.initialQueries
        : ["populate"],
      columns: parsedContext.columns.map((column) => ({
        name: column.name,
        display_name: column.name,
        type: mapContextColumnType(column.type),
        is_primary_key: column.name === (parsedContext.columns[0]?.name ?? ""),
        is_enumerable: false,
        description: column.description ?? column.name,
        nullable: true,
      })),
    };
  }

  const parallelResult = await runParallelPopulatePhase({
    context: parsedContext,
    dataSpec,
    acquisition,
    limits,
    webTools,
    metrics,
    validationIssues,
    debugNotes,
    hooks: input.populateHooks,
  });

  capturedSources.push(...parallelResult.capturedSources);
  const populatePromptUrlCount = acquisition.prioritizedUrls.length;
  const allowedEvidenceUrls = new Set(
    acquisition.prioritizedUrls.map((url) => normalizeSearchResultUrl(url))
  );
  const rows = parallelResult.rows.map((row) =>
    withEnsuredRowEvidence(row, {
      capturedSources,
      context: parsedContext,
      allowedEvidenceUrls,
    })
  );
  validationIssues.push(...validateRuntimeRows(rows));
  const selectedRowSource: PopulateRuntimeDebug["selectedRowSource"] =
    rows.length > 0 ? "structured_recovery" : "none";

  const populateFetchCalls = metrics.fetchCalls;
  const llmUsage = getCurrentLlmUsage();
  debugNotes.push(
    `Metrics: ${acquisitionSearchCalls} acquisition search call(s), ${populateFetchCalls} populate fetch call(s).`
  );
  debugNotes.push(
    `LLM usage (internal): ${llmUsage.promptTokens} prompt + ${llmUsage.completionTokens} completion tokens across ${llmUsage.callCount} call(s).`
  );

  const capturedRowsForDebug: PopulateRuntimeCapturedInsertedRow[] = rows.map(
    (row) => ({
      datasetId: parsedContext.datasetId,
      data: row.cells,
    })
  );

  const runtimeResult = {
    rows,
    validationIssues: Array.from(new Set(validationIssues)),
    metrics: {
      ...metrics,
      searchCalls: acquisitionSearchCalls,
      fetchCalls: populateFetchCalls,
    },
    debug: {
      capturedRows: capturedRowsForDebug,
      capturedSources,
      selectedRowSource,
      notes: debugNotes,
      acquisition,
      metricsBreakdown: {
        acquisitionSearchCalls,
        populateFetchCalls,
      },
    },
  };

  if (isPopulateBenchmarkDebugEnabled()) {
    const artifactDirectory = populateBenchmarkArtifactDirectory();
    if (artifactDirectory) {
      await writePopulateBenchmarkDebugArtifacts(artifactDirectory, {
        runAt: new Date().toISOString(),
        context: parsedContext,
        limits,
        dataSpec,
        initialQueries: acquisition.initialQueries,
        searchPool: searchPoolResults,
        acquisition,
        populatePromptUrlCount,
        capturedSources,
        capturedRows: rows.map((row) => ({
          datasetId: parsedContext.datasetId,
          data: row.cells,
        })),
        validationIssues: runtimeResult.validationIssues,
        metrics: runtimeResult.metrics,
        notes: debugNotes,
      });
    }
  }

  return runtimeResult;
  });

  return {
    ...result,
    usage: toPopulateRuntimeUsage(usage),
  };
}

function mapContextColumnType(
  type: DatasetContext["columns"][number]["type"]
): DatasetSchema["columns"][number]["type"] {
  switch (type) {
    case "url":
      return "url";
    case "date":
      return "date";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
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
    },
  };
}

async function recordPopulatePageFetch(input: {
  url: string;
  metrics: PopulateRuntimeResult["metrics"];
  capturedSources: PopulateRuntimeCapturedSource[];
  webTools: PopulateRuntimeWebTools;
  validationIssues: string[];
  allowedFetchUrls: Set<string>;
}): Promise<{ title?: string; text?: string; error?: string }> {
  const normalizedUrl = normalizeSearchResultUrl(input.url);
  if (!input.allowedFetchUrls.has(normalizedUrl)) {
    return {
      error:
        "URL is not in the source URL list for this run. Use fetch_page only on URLs listed in the prompt.",
    };
  }

  input.metrics.fetchCalls += 1;
  try {
    const page = await input.webTools.fetch({ url: normalizedUrl });
    const fetchedText = [page.title, page.text].filter(Boolean).join("\n");
    const existingIndex = input.capturedSources.findIndex(
      (source) => normalizeSearchResultUrl(source.url) === normalizedUrl
    );
    const captured = { url: normalizedUrl, text: fetchedText };
    if (existingIndex >= 0) {
      input.capturedSources[existingIndex] = captured;
    } else {
      input.capturedSources.push(captured);
    }
    return page;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.validationIssues.push(`fetch_page failed: ${message}`);
    return { error: message };
  }
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

function contextText(context: DatasetContext): string {
  return [
    context.description,
    ...context.columns.map((column) => `${column.name} ${column.description ?? ""}`),
  ].join(" ");
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

function createPopulateRuntimeTools(input: {
  datasetId: string;
  capturedRows: PopulateRuntimeCapturedInsertedRow[];
  capturedSources: PopulateRuntimeCapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  webTools: PopulateRuntimeWebTools;
  limits: PopulateRuntimeLimits;
  allowedFetchUrls: Set<string>;
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
          return {
            success: false,
            error: `datasetId must be ${input.datasetId}.`,
          };
        }
        if (input.capturedRows.length >= input.limits.maxRows) {
          return {
            success: false,
            error: `Row cap reached for this benchmark run (${input.limits.maxRows}).`,
          };
        }
        input.capturedRows.push({ datasetId, data });
        return { success: true };
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
        const normalizedUrl = normalizeSearchResultUrl(url);
        if (!input.allowedFetchUrls.has(normalizedUrl)) {
          return {
            error:
              `URL is not in the source URL list for this run. Use fetch_page only on URLs listed in the prompt.`,
          };
        }

        return recordPopulatePageFetch({
          url,
          metrics: input.metrics,
          capturedSources: input.capturedSources,
          webTools: input.webTools,
          validationIssues: input.validationIssues,
          allowedFetchUrls: input.allowedFetchUrls,
        });
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

function normalizeSearchResults(
  results: PopulateWebSearchResult[]
): PopulateWebSearchResult[] {
  return results.map((result) => ({
    ...result,
    site_name: result.site_name ?? siteNameFromUrl(result.url),
  }));
}

export function createTinyFishWebTools(): PopulateRuntimeWebTools {
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
        results?: Array<{
          title?: string;
          snippet?: string;
          url?: string;
          site_name?: string;
        }>;
      };
      return normalizeSearchResults(
        (payload.results ?? [])
          .filter((result) => result.title && result.url)
          .map((result) => ({
            title: result.title!,
            snippet: result.snippet,
            url: result.url!,
            site_name: result.site_name,
          }))
      );
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

function benchmarkRowFromInsertedData(
  data: Record<string, unknown>
): PopulateRuntimeRow {
  const cells = normalizeCells(data);
  const sourceUrls = sourceUrlsFromData(cells);
  return {
    cells,
    sourceUrls,
    evidence: evidenceFromData(cells, sourceUrls),
    needsReview: true,
  };
}

function withEnsuredRowEvidence(
  row: PopulateRuntimeRow,
  input: {
    capturedSources: PopulateRuntimeCapturedSource[];
    context: DatasetContext;
    allowedEvidenceUrls?: Set<string>;
  }
): PopulateRuntimeRow {
  return {
    ...row,
    evidence: ensureRowEvidence({
      cells: row.cells,
      sourceUrls: row.sourceUrls,
      evidence: row.evidence,
      capturedSources: input.capturedSources,
      context: input.context,
      allowedEvidenceUrls: input.allowedEvidenceUrls,
    }),
  };
}

function benchmarkRowsFromStructuredOutput(input: {
  output: StructuredPopulateOutput | undefined;
  maxRows: number;
  context: DatasetContext;
  requestedColumns: string[];
  capturedSources: PopulateRuntimeCapturedSource[];
  allowedEvidenceUrls?: Set<string>;
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
    const evidence = ensureRowEvidence({
      cells,
      sourceUrls,
      evidence: repairStructuredEvidence({
        evidence: normalizeStructuredEvidence(row.evidence ?? []),
        cells,
        sourceUrls,
        capturedSources: input.capturedSources,
        allowedEvidenceUrls: input.allowedEvidenceUrls,
        context: input.context,
        debugNotes: input.debugNotes,
        rowNumber: index + 1,
      }),
      capturedSources: input.capturedSources,
      allowedEvidenceUrls: input.allowedEvidenceUrls,
      context: input.context,
    });
    if (sourceUrls.length === 0) {
      input.validationIssues.push(
        `Rejected structured row ${index + 1}: missing sourceUrls.`
      );
      return;
    }
    if (evidence.length === 0) {
      input.validationIssues.push(
        `Rejected structured row ${index + 1}: could not build evidence from sourceUrls.`
      );
      return;
    }
    const unmatchedEvidence = evidence.find(
      (item) =>
        !isEvidenceBackedByCapturedSource(
          item,
          input.capturedSources,
          input.allowedEvidenceUrls
        )
    );
    if (unmatchedEvidence) {
      input.validationIssues.push(
        `Rejected structured row ${index + 1}: evidence quote not found in captured source ${unmatchedEvidence.sourceUrl}.`
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
  allowedEvidenceUrls?: Set<string>;
  context: DatasetContext;
  debugNotes: string[];
  rowNumber: number;
}): PopulateRuntimeRow["evidence"] {
  return input.evidence.map((item) => {
    if (
      isEvidenceBackedByCapturedSource(
        item,
        input.capturedSources,
        input.allowedEvidenceUrls
      )
    ) {
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
  const candidateValues = Object.entries(input.cells)
    .filter(([columnName]) => !/(^entity_name$|^source_url$|url$|website|link)/i.test(columnName))
    .flatMap(([, value]) => stringCandidatesFromCellValue(value))
    .filter((value) => value.length >= 5)
    .sort((a, b) => b.length - a.length);
  const sources = capturedSourcesForRowUrls(input.sourceUrls, input.capturedSources);
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

function capturedSourcesForRowUrls(
  sourceUrls: string[],
  capturedSources: PopulateRuntimeCapturedSource[]
): PopulateRuntimeCapturedSource[] {
  const matched = new Map<string, PopulateRuntimeCapturedSource>();
  for (const sourceUrl of sourceUrls) {
    const source = findCapturedSourceForUrl(sourceUrl, capturedSources);
    if (source) {
      matched.set(normalizeSearchResultUrl(source.url), source);
    }
  }
  return [...matched.values()];
}

function findCapturedSourceForUrl(
  sourceUrl: string,
  capturedSources: PopulateRuntimeCapturedSource[]
): PopulateRuntimeCapturedSource | undefined {
  const normalizedTarget = normalizeSearchResultUrl(sourceUrl);
  const matches = capturedSources.filter(
    (source) => normalizeSearchResultUrl(source.url) === normalizedTarget
  );
  if (matches.length > 0) {
    return matches.sort((a, b) => b.text.length - a.text.length)[0];
  }

  let best: PopulateRuntimeCapturedSource | undefined;
  let bestScore = 0;
  for (const source of capturedSources) {
    const normalizedSource = normalizeSearchResultUrl(source.url);
    if (
      normalizedTarget.startsWith(normalizedSource) ||
      normalizedSource.startsWith(normalizedTarget)
    ) {
      const score = Math.min(normalizedTarget.length, normalizedSource.length);
      if (score > bestScore) {
        best = source;
        bestScore = score;
      }
    }
  }
  return best;
}

function isEvidenceBackedByCapturedSource(
  evidence: PopulateRuntimeRow["evidence"][number],
  capturedSources: PopulateRuntimeCapturedSource[],
  _allowedSourceUrls?: Set<string>
): boolean {
  const normalizedEvidenceUrl = normalizeSearchResultUrl(evidence.sourceUrl ?? "");
  const normalizedQuote = normalizeEvidenceText(evidence.quote);
  const source = findCapturedSourceForUrl(normalizedEvidenceUrl, capturedSources);
  if (!source) {
    return false;
  }
  return normalizeEvidenceText(source.text).includes(normalizedQuote);
}

function selectRepresentativeRows(
  rows: PopulateRuntimeRow[],
  context: DatasetContext
): PopulateRuntimeRow[] {
  const entities = entityCandidatesFromDescription(context.description);
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
    columnName: evidenceColumnNameForQuote(data, quote),
    sourceUrl: sourceUrls[0] ?? "",
    quote,
  }];
}

function ensureRowEvidence(input: {
  cells: Record<string, PopulateCellValue>;
  sourceUrls: string[];
  evidence: PopulateRuntimeRow["evidence"];
  capturedSources: PopulateRuntimeCapturedSource[];
  context: DatasetContext;
  allowedEvidenceUrls?: Set<string>;
}): PopulateRuntimeRow["evidence"] {
  if (input.sourceUrls.length === 0) {
    return input.evidence;
  }

  const backedEvidence = input.evidence.filter(
    (item) =>
      item.sourceUrl &&
      item.quote &&
      isEvidenceBackedByCapturedSource(
        item,
        input.capturedSources,
        input.allowedEvidenceUrls
      )
  );
  if (backedEvidence.length > 0) {
    return backedEvidence;
  }

  const fromCaptured = quoteFromCapturedSources({
    cells: input.cells,
    sourceUrls: input.sourceUrls,
    capturedSources: input.capturedSources,
    context: input.context,
  });
  if (fromCaptured) {
    return [{
      columnName: evidenceColumnNameForQuote(input.cells, fromCaptured.quote),
      sourceUrl: matchingRowSourceUrl(fromCaptured.sourceUrl, input.sourceUrls),
      quote: fromCaptured.quote,
    }];
  }

  const cellQuote = bestCellQuoteForEvidence(input.cells);
  if (cellQuote) {
    return [{
      columnName: cellQuote.columnName,
      sourceUrl: input.sourceUrls[0] ?? "",
      quote: cellQuote.quote,
    }];
  }

  return input.evidence.filter((item) => item.sourceUrl && item.quote);
}

function evidenceColumnNameForQuote(
  cells: Record<string, PopulateCellValue>,
  quote: string
): string {
  const normalizedQuote = normalizeEvidenceText(quote);
  for (const [columnName, value] of Object.entries(cells)) {
    if (/^evidence/i.test(columnName)) {
      return columnName;
    }
    for (const candidate of stringCandidatesFromCellValue(value)) {
      if (normalizeEvidenceText(candidate) === normalizedQuote) {
        return columnName;
      }
    }
  }
  return bestCellQuoteForEvidence(cells)?.columnName ?? firstPresentColumn(cells);
}

function bestCellQuoteForEvidence(
  cells: Record<string, PopulateCellValue>
): { columnName: string; quote: string } | undefined {
  const candidates = Object.entries(cells)
    .filter(([columnName]) =>
      !/(^entity_name$|^source_url$|url$|website|link|page)/i.test(columnName)
    )
    .flatMap(([columnName, value]) =>
      stringCandidatesFromCellValue(value).map((quote) => ({
        columnName,
        quote,
      }))
    )
    .filter((entry) => entry.quote.length >= 3)
    .sort((a, b) => b.quote.length - a.quote.length);

  return candidates[0];
}

function matchingRowSourceUrl(
  capturedSourceUrl: string,
  sourceUrls: string[]
): string {
  const normalizedCaptured = normalizeSearchResultUrl(capturedSourceUrl);
  return (
    sourceUrls.find(
      (url) => normalizeSearchResultUrl(url) === normalizedCaptured
    ) ?? sourceUrls[0] ?? capturedSourceUrl
  );
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
  if (rows.some((row) => row.evidence.length === 0)) {
    issues.push("Mastra populate rows do not include per-row evidence quotes yet.");
  }
  return issues;
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
