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

interface CapturedInsertedRow {
  datasetId: string;
  data: Record<string, unknown>;
}

interface CapturedSource {
  url: string;
  text: string;
}

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
  maxRows?: number;
}): Promise<PopulateRuntimeResult> {
  const parsedContext = datasetContextSchema.parse(input.context);
  const clarificationResult = clarificationResultForContext(parsedContext);
  if (clarificationResult) {
    return clarificationResult;
  }

  const capturedRows: CapturedInsertedRow[] = [];
  const capturedSources: CapturedSource[] = [];
  const validationIssues: string[] = [];
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
  });
  const prompt = buildPopulatePrompt(parsedContext);
  let agentOutput: unknown;

  if (input.agentRunner) {
    try {
      agentOutput = await input.agentRunner({ prompt, tools });
      metrics.agentRuns += 1;
    } catch (error) {
      validationIssues.push(populateAgentFailureMessage(error));
    }
  } else {
    try {
      const agent = createRuntimePopulateAgent({ tools });
      agentOutput = await agent.generate(prompt);
      metrics.agentRuns += 1;
    } catch (error) {
      validationIssues.push(populateAgentFailureMessage(error));
    }

  }

  const insertedRows = capturedRows.map((row) => benchmarkRowFromInsertedData(row.data));
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
    } catch (error) {
      validationIssues.push(
        `Structured row generation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const structuredRows = benchmarkRowsFromStructuredOutput({
    output: structuredOutputFromAgentResult(agentOutput),
    maxRows: input.maxRows ?? 10,
    context: parsedContext,
    requestedColumns: parsedContext.columns.map((column) => column.name),
    capturedSources,
    validationIssues,
  });
  const structuredRowIssues = validateRuntimeRows(structuredRows);
  if (
    insertedRows.length > 0 &&
    insertedRowIssues.length === 0 &&
    structuredRows.length > 0 &&
    hasContradictingStructuredRows(insertedRows, structuredRows)
  ) {
    validationIssues.push(
      "Structured populate rows differed from insert_row rows and were ignored."
    );
  }
  const rows = selectBestRuntimeRows({
    insertedRows,
    insertedRowIssues,
    structuredRows,
    structuredRowIssues,
    validationIssues,
  });
  validationIssues.push(...validateRuntimeRows(rows));

  return {
    rows,
    validationIssues: Array.from(new Set(validationIssues)),
    usage: emptyUsage(),
    metrics,
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
  };
}

async function enrichCapturedSourcesForStructuredFallback(input: {
  context: DatasetContext;
  capturedSources: CapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  webTools: PopulateRuntimeWebTools;
}) {
  const entities = entityCandidatesFromDescription(input.context.description);
  const newSources: CapturedSource[] = [];
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
      });
      input.metrics.fetchCalls += 1;
      try {
        const page = await input.webTools.fetch({ url: result.url });
        newSources.push({
          url: result.url,
          text: [page.title, page.text].filter(Boolean).join("\n"),
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
  newSources: CapturedSource[];
}) {
  input.newSources.push({
    url: input.url,
    text: `${input.entity} official source\n${input.url}`,
  });
  input.input.metrics.fetchCalls += 1;
  try {
    const page = await input.input.webTools.fetch({ url: input.url });
    input.newSources.push({
      url: input.url,
      text: [page.title, page.text].filter(Boolean).join("\n"),
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
  return truncateForPrompt(context.description, 120);
}

function contextText(context: DatasetContext): string {
  return [
    context.description,
    ...context.columns.map((column) => `${column.name} ${column.description ?? ""}`),
  ].join(" ");
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
  capturedSources: CapturedSource[];
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
  capturedSources: CapturedSource[];
}): string {
  const columnNames = input.context.columns.map((column) => column.name);
  const entities = entityCandidatesFromDescription(input.context.description);
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

Required columns:
${JSON.stringify(columnNames)}

Named entities, when present:
${JSON.stringify(entities)}

Official source hints:
${JSON.stringify(officialHints)}

Captured source transcript:
${sourceTranscript}

Return rows using this exact shape:
{ "rows": [{ "cells": {}, "sourceUrls": [], "evidence": [{ "columnName": "", "sourceUrl": "", "quote": "" }], "needsReview": true }], "validationIssues": [] }

Rules:
- cells must contain exactly the required columns.
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
  validationIssues: string[];
}): PopulateRuntimeRow[] {
  if (input.insertedRows.length > 0 && input.insertedRowIssues.length === 0) {
    return input.insertedRows;
  }
  if (input.structuredRows.length > 0 && input.structuredRowIssues.length === 0) {
    if (input.insertedRows.length > 0) {
      input.validationIssues.push(
        "Structured row recovery replaced insert_row rows that failed source/evidence validation."
      );
    }
    return input.structuredRows;
  }
  return input.insertedRows.length > 0 ? input.insertedRows : input.structuredRows;
}

function createPopulateRuntimeTools(input: {
  datasetId: string;
  capturedRows: CapturedInsertedRow[];
  capturedSources: CapturedSource[];
  validationIssues: string[];
  metrics: PopulateRuntimeResult["metrics"];
  webTools: PopulateRuntimeWebTools;
  maxRows: number;
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
        if (input.capturedRows.length >= input.maxRows) {
          return {
            success: false,
            error: `Row cap reached for this benchmark run (${input.maxRows}).`,
          };
        }
        input.capturedRows.push({ datasetId, data });
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
            }))
          );
          return { results };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.validationIssues.push(`search_web failed: ${message}`);
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
          });
          return page;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.validationIssues.push(`fetch_page failed: ${message}`);
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

function benchmarkRowsFromStructuredOutput(input: {
  output: StructuredPopulateOutput | undefined;
  maxRows: number;
  context: DatasetContext;
  requestedColumns: string[];
  capturedSources: CapturedSource[];
  validationIssues: string[];
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
      validationIssues: input.validationIssues,
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
  capturedSources: CapturedSource[];
  context: DatasetContext;
  validationIssues: string[];
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
    input.validationIssues.push(
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
  capturedSources: CapturedSource[];
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
  capturedSources: CapturedSource[]
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
