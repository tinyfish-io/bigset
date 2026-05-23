import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

import { recordAgentGenerationUsage } from "./llm-usage.js";
import { DEFAULT_OPENROUTER_MODEL_ID, requiredOpenRouterApiKey } from "../openrouter-models.js";
import {
  buildSearchAcquisitionPrompt,
  searchAcquisitionAgentInstructions,
} from "./populate-acquisition-prompt.js";
import {
  inferSchema,
  resolvePopulateDataSpec,
} from "./schema-inference.js";
import type { DatasetContext } from "./populate.js";
import {
  acquisitionScoredUrlSchema,
  populateAcquisitionResultSchema,
  searchAcquisitionCompletionSchema,
  type AcquisitionScoredUrl,
  type AgentSearchScore,
  type DatasetSchema,
  type PopulateAcquisitionResult,
} from "./types.js";
import {
  finalizePrioritizedSearchResults,
  normalizeSearchResultUrl,
  siteNameFromUrl,
} from "./populate-search-prioritization.js";
import type { PopulateRuntimeResult } from "./populate-runtime.js";
import type {
  PopulateRuntimeCapturedSource,
  PopulateRuntimeWebTools,
  PopulateWebSearchResult,
} from "./populate-web-types.js";

export type {
  AcquisitionScoredUrl,
  PopulateAcquisitionResult,
} from "./types.js";
export {
  acquisitionScoredUrlSchema,
  populateAcquisitionResultSchema,
} from "./types.js";

export type SearchAcquisitionPhaseResult = Pick<
  PopulateAcquisitionResult,
  "scoredUrls" | "initialQueries" | "validationIssues"
> & {
  dataSpec: DatasetSchema;
  searchPoolResults: Array<{
    title: string;
    snippet?: string;
    url: string;
    site_name?: string;
    search_query: string;
  }>;
};

/** URLs the populate agent may fetch — capped fetch list, not the full acquisition pool. */
export type PopulateFetchPlan = {
  fetchUrls: AcquisitionScoredUrl[];
};

export function buildPopulateFetchPlan(
  acquisition: PopulateAcquisitionResult
): PopulateFetchPlan {
  const scoreByUrl = new Map(
    acquisition.scoredUrls.map((entry) => [
      normalizeSearchResultUrl(entry.url),
      entry,
    ])
  );

  return {
    fetchUrls: acquisition.prioritizedUrls.map((url) => {
      const normalized = normalizeSearchResultUrl(url);
      return (
        scoreByUrl.get(normalized) ?? {
          url: normalized,
          expectation_score: 1,
          search_query: "",
        }
      );
    }),
  };
}

interface PooledSearchResult extends PopulateWebSearchResult {
  search_query: string;
}

export type SearchAcquisitionAgentRunner = (input: {
  prompt: string;
  tools: Record<string, unknown>;
}) => Promise<unknown>;

export function sortAcquisitionScoredUrls(
  scoredUrls: AcquisitionScoredUrl[]
): AcquisitionScoredUrl[] {
  return [...scoredUrls].sort((a, b) => {
    if (b.expectation_score !== a.expectation_score) {
      return b.expectation_score - a.expectation_score;
    }
    return a.url.localeCompare(b.url);
  });
}

export function buildPrioritizedFetchUrls(
  scoredUrls: AcquisitionScoredUrl[],
  fetchLimit: number
): string[] {
  return sortAcquisitionScoredUrls(scoredUrls)
    .slice(0, fetchLimit)
    .map((entry) => normalizeSearchResultUrl(entry.url));
}

export function captureScoredUrlsAsSources(
  scoredUrls: AcquisitionScoredUrl[]
): PopulateRuntimeCapturedSource[] {
  return scoredUrls.map((entry) => ({
    url: normalizeSearchResultUrl(entry.url),
    text: [
      `expectation_score: ${entry.expectation_score}`,
      `search_query: ${entry.search_query}`,
    ].join("\n"),
  }));
}

export function finalizeAcquisitionResult(
  phase: SearchAcquisitionPhaseResult,
  fetchLimit: number
): PopulateAcquisitionResult {
  const scoredUrls = sortAcquisitionScoredUrls(phase.scoredUrls);
  return {
    initialQueries: phase.initialQueries,
    validationIssues: phase.validationIssues,
    scoredUrls,
    prioritizedUrls: buildPrioritizedFetchUrls(scoredUrls, fetchLimit),
  };
}

export function normalizePopulateAcquisitionResult(
  acquisition: PopulateAcquisitionResult,
  fetchLimit: number
): PopulateAcquisitionResult {
  return finalizeAcquisitionResult(acquisition, fetchLimit);
}

export async function runSearchAcquisitionPhase(input: {
  context: DatasetContext;
  dataSpec?: DatasetSchema;
  maxSearchCalls: number;
  webTools: PopulateRuntimeWebTools;
  metrics: PopulateRuntimeResult["metrics"];
  validationIssues: string[];
  debugNotes: string[];
  searchAcquisitionRunner?: SearchAcquisitionAgentRunner;
  inferSchemaFn?: typeof inferSchema;
}): Promise<SearchAcquisitionPhaseResult> {
  const { dataSpec, initialQueries } = await resolvePopulateDataSpec({
    prompt: input.context.description,
    dataSpec: input.dataSpec,
    maxSearchCalls: input.maxSearchCalls,
    inferSchemaFn: input.inferSchemaFn,
  });
  const searchPool = new Map<string, PooledSearchResult>();
  const tools = createSearchAcquisitionTools({
    maxSearchCalls: input.maxSearchCalls,
    webTools: input.webTools,
    metrics: input.metrics,
    validationIssues: input.validationIssues,
    searchPool,
  });
  const prompt = buildSearchAcquisitionPrompt(
    input.context,
    initialQueries,
    input.maxSearchCalls,
    dataSpec
  );

  let agentOutput: unknown;
  if (input.searchAcquisitionRunner) {
    agentOutput = await input.searchAcquisitionRunner({ prompt, tools });
    recordAgentGenerationUsage(agentOutput);
    input.metrics.agentRuns += 1;
  } else {
    const agent = createSearchAcquisitionAgent({ tools });
    agentOutput = await agent.generate(prompt, {
      structuredOutput: {
        schema: searchAcquisitionCompletionSchema,
        jsonPromptInjection: true,
        errorStrategy: "fallback",
        fallbackValue: { scored_urls: [], validation_issues: [] },
      },
    });
    recordAgentGenerationUsage(agentOutput);
    input.metrics.agentRuns += 1;
  }

  const completion = searchAcquisitionCompletionSchema.parse(
    structuredAcquisitionFromAgentResult(agentOutput)
  );
  completion.validation_issues.forEach((issue) => {
    input.validationIssues.push(`Search acquisition agent: ${issue}`);
  });

  const pooledResults = [...searchPool.values()];
  const pooledUrlSet = new Set(
    pooledResults.map((result) => normalizeSearchResultUrl(result.url))
  );
  const agentScores: AgentSearchScore[] = completion.scored_urls.filter((score) =>
    pooledUrlSet.has(normalizeSearchResultUrl(score.url))
  );
  const rankedForScoring = finalizePrioritizedSearchResults({
    context: input.context,
    dataSpec,
    results: pooledResults,
    agentScores,
  });

  const searchQueryByUrl = new Map(
    pooledResults.map((result) => [
      normalizeSearchResultUrl(result.url),
      result.search_query,
    ])
  );
  const scoredUrls = rankedForScoring.map((result) => ({
    url: normalizeSearchResultUrl(result.url),
    expectation_score: result.expectation_score,
    search_query: searchQueryByUrl.get(normalizeSearchResultUrl(result.url)) ?? "",
  }));
  const sortedScoredUrls = sortAcquisitionScoredUrls(scoredUrls);
  input.debugNotes.push(
    `Search acquisition: ${input.metrics.searchCalls}/${input.maxSearchCalls} search call(s), ${initialQueries.length} initial query seed(s), ${pooledResults.length} unique result(s), ${sortedScoredUrls.length} scored URL(s).`
  );

  return {
    scoredUrls: sortedScoredUrls,
    initialQueries,
    validationIssues: completion.validation_issues,
    dataSpec,
    searchPoolResults: pooledResults.map((result) => ({
      title: result.title,
      snippet: result.snippet,
      url: result.url,
      site_name: result.site_name,
      search_query: result.search_query,
    })),
  };
}

function createSearchAcquisitionAgent(input: { tools: Record<string, unknown> }) {
  const openrouter = createOpenRouter({ apiKey: requiredOpenRouterApiKey() });

  return new Agent({
    id: "populate-search-acquisition-agent",
    name: "Populate Search Acquisition Agent",
    instructions: searchAcquisitionAgentInstructions,
    model: openrouter(DEFAULT_OPENROUTER_MODEL_ID),
    tools: input.tools as ConstructorParameters<typeof Agent>[0]["tools"],
  });
}

function createSearchAcquisitionTools(input: {
  maxSearchCalls: number;
  webTools: PopulateRuntimeWebTools;
  metrics: PopulateRuntimeResult["metrics"];
  validationIssues: string[];
  searchPool: Map<string, PooledSearchResult>;
}) {
  return {
    search_web: createTool({
      id: "search_web",
      description: "Search the web for candidate source pages.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        results: z.array(z.object({
          title: z.string(),
          snippet: z.string().optional(),
          url: z.string(),
          site_name: z.string().optional(),
        })).optional(),
        error: z.string().optional(),
      }),
      execute: async ({ query }) => {
        if (input.metrics.searchCalls >= input.maxSearchCalls) {
          return {
            error: `Search budget exhausted (${input.maxSearchCalls} search_web calls). Score every URL collected so far and return.`,
          };
        }

        input.metrics.searchCalls += 1;
        try {
          const results = normalizeSearchResults(
            await input.webTools.search({ query })
          );
          for (const result of results) {
            const key = normalizeSearchResultUrl(result.url);
            if (!input.searchPool.has(key)) {
              input.searchPool.set(key, { ...result, search_query: query });
            }
          }
          return { results };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.validationIssues.push(`search_web failed: ${message}`);
          return { error: message };
        }
      },
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

function structuredAcquisitionFromAgentResult(agentOutput: unknown): unknown {
  if (!agentOutput || typeof agentOutput !== "object") {
    return { scored_urls: [], validation_issues: [] };
  }

  const record = agentOutput as Record<string, unknown>;
  if (record.object && typeof record.object === "object") {
    return record.object;
  }
  if (Array.isArray(record.scored_urls)) {
    return record;
  }
  return { scored_urls: [], validation_issues: [] };
}
