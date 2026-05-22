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

export async function runPopulateRuntime(input: {
  context: DatasetContext;
  webTools?: PopulateRuntimeWebTools;
  agentRunner?: PopulateRuntimeAgentRunner;
  maxRows?: number;
}): Promise<PopulateRuntimeResult> {
  const parsedContext = datasetContextSchema.parse(input.context);
  const capturedRows: CapturedInsertedRow[] = [];
  const validationIssues: string[] = [];
  const metrics = emptyMetrics();
  const tools = createPopulateRuntimeTools({
    datasetId: parsedContext.datasetId,
    capturedRows,
    validationIssues,
    metrics,
    webTools: input.webTools ?? createTinyFishWebTools(),
    maxRows: input.maxRows ?? 10,
  });
  const prompt = buildPopulatePrompt(parsedContext);

  try {
    if (input.agentRunner) {
      await input.agentRunner({ prompt, tools });
    } else {
      const agent = createRuntimePopulateAgent({ tools });
      await agent.generate(prompt);
    }
    metrics.agentRuns += 1;
  } catch (error) {
    validationIssues.push(
      `Populate agent failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const rows = capturedRows.map((row) => benchmarkRowFromInsertedData(row.data));
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

function createPopulateRuntimeTools(input: {
  datasetId: string;
  capturedRows: CapturedInsertedRow[];
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
          return { results: await input.webTools.search({ query }) };
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
          return await input.webTools.fetch({ url });
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
