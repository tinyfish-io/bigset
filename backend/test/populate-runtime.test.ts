import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runSearchAcquisitionPhase,
  type PopulateAcquisitionResult,
} from "../src/pipeline/populate-acquisition.js";
import { buildPopulateExtractionSpec } from "../src/pipeline/populate-extraction-spec.js";
import { resolveInitialSearchQueryCap } from "../src/pipeline/schema-inference.js";
import { runPopulateRuntime } from "../src/pipeline/populate-runtime.js";
import { normalizeSearchResultUrl } from "../src/pipeline/populate-search-prioritization.js";
import type { DatasetSchema } from "../src/pipeline/types.js";
import { buildMockRow, mockTriageExtractHooks } from "./populate-test-hooks.js";

interface ToolLike<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

const context = {
  datasetId: "benchmark-dataset",
  datasetName: "benchmark_dataset",
  description: "Find latest blog posts from OpenAI.",
  columns: [
    {
      name: "entity_name",
      type: "text" as const,
      description: "Company name.",
    },
    {
      name: "latest_post_title",
      type: "text" as const,
      description: "Latest post title.",
    },
    {
      name: "source_url",
      type: "url" as const,
      description: "Source URL.",
    },
    {
      name: "evidence_quote",
      type: "text" as const,
      description: "Evidence quote.",
    },
  ],
};

function mockPopulateDataSpec(maxSearchCalls: number): DatasetSchema {
  const queryCount = resolveInitialSearchQueryCap(maxSearchCalls);
  return {
    dataset_name: "benchmark_dataset",
    description: context.description,
    primary_key: "entity_name",
    search_queries: Array.from(
      { length: queryCount },
      (_, index) => `seed query ${index + 1}`
    ),
    columns: [
      {
        name: "entity_name",
        display_name: "Company",
        type: "string",
        is_primary_key: true,
        is_enumerable: true,
        description: "Company name on the official blog or news page.",
        nullable: false,
      },
      {
        name: "latest_post_title",
        display_name: "Latest post",
        type: "string",
        is_primary_key: false,
        is_enumerable: false,
        description: "Title of the latest blog post.",
        nullable: true,
      },
      {
        name: "source_url",
        display_name: "Source URL",
        type: "url",
        is_primary_key: false,
        is_enumerable: false,
        description: "Canonical URL of the latest post.",
        nullable: true,
      },
    ],
  };
}

function mockAcquisition(input: {
  results: Array<{
    url: string;
    expectation_score?: number;
    search_query?: string;
  }>;
  fetchLimit?: number;
}): PopulateAcquisitionResult {
  const scoredUrls = [...input.results]
    .map((result) => ({
      url: normalizeSearchResultUrl(result.url),
      expectation_score: result.expectation_score ?? 5,
      search_query: result.search_query ?? "Find latest blog posts from OpenAI.",
    }))
    .sort((a, b) => b.expectation_score - a.expectation_score);

  const limitedResults =
    input.fetchLimit === undefined
      ? scoredUrls
      : scoredUrls.slice(0, input.fetchLimit);

  return {
    prioritizedUrls: limitedResults.map((result) => result.url),
    scoredUrls,
    initialQueries: ["Find latest blog posts from OpenAI."],
    validationIssues: [],
  };
}

const openAiNewsUrl = "https://openai.com/news";
const openAiNewsAcquisition = mockAcquisition({
  results: [{ url: openAiNewsUrl }],
});
const testDataSpec = mockPopulateDataSpec(10);
const testExtractionSpec = buildPopulateExtractionSpec({
  context,
  dataSpec: testDataSpec,
});

const emptyMetrics = () => ({
  searchCalls: 0,
  fetchCalls: 0,
  browserCalls: 0,
  agentRuns: 0,
  agentSteps: 0,
});

test("populate runtime captures rows through parallel triage extract workers", async () => {
  const result = await runPopulateRuntime({
    context,
    dataSpec: testDataSpec,
    acquisition: openAiNewsAcquisition,
    webTools: {
      search: async () => [],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes",
      }),
    },
    populateHooks: mockTriageExtractHooks({
      recordsByUrl: {
        [openAiNewsUrl]: [
          buildMockRow({
            spec: testExtractionSpec,
            entityName: "OpenAI",
            sourceUrl: openAiNewsUrl,
            extraCells: { latest_post_title: "Release notes", evidence_quote: "Release notes" },
            quote: "Release notes",
          }),
        ],
      },
    }),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
  assert.deepEqual(result.rows[0]?.sourceUrls, [openAiNewsUrl]);
  assert.equal(result.rows[0]?.evidence[0]?.quote, "Release notes");
  assert.equal(result.metrics.searchCalls, 0);
  assert.equal(result.metrics.fetchCalls, 1);
  assert.ok(result.metrics.agentRuns >= 1);
  assert.deepEqual(result.validationIssues, []);
});

test("populate runtime synthesizes evidence when row lacks explicit evidence_quote cell", async () => {
  const result = await runPopulateRuntime({
    context,
    dataSpec: testDataSpec,
    acquisition: openAiNewsAcquisition,
    webTools: {
      search: async () => [],
      fetch: async () => ({
        text: "Release notes from OpenAI about the latest model.",
      }),
    },
    populateHooks: mockTriageExtractHooks({
      recordsByUrl: {
        [openAiNewsUrl]: [
          buildMockRow({
            spec: testExtractionSpec,
            entityName: "OpenAI",
            sourceUrl: openAiNewsUrl,
            extraCells: {
              latest_post_title: "Release notes from OpenAI",
              evidence_quote: "",
            },
            quote: "Release notes from OpenAI about the latest model.",
          }),
        ],
      },
    }),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.sourceUrls[0], openAiNewsUrl);
  assert.ok((result.rows[0]?.evidence.length ?? 0) > 0);
});

test("populate runtime enforces per-run row cap during merge", async () => {
  const secondUrl = "https://anthropic.com/news";
  const result = await runPopulateRuntime({
    context,
    dataSpec: testDataSpec,
    maxRows: 1,
    acquisition: mockAcquisition({
      results: [{ url: openAiNewsUrl }, { url: secondUrl }],
    }),
    webTools: {
      search: async () => [],
      fetch: async () => ({ text: "content" }),
    },
    populateHooks: mockTriageExtractHooks({
      recordsByUrl: {
        [openAiNewsUrl]: [
          buildMockRow({
            spec: testExtractionSpec,
            entityName: "OpenAI",
            sourceUrl: openAiNewsUrl,
            quote: "OpenAI evidence",
          }),
        ],
        [secondUrl]: [
          buildMockRow({
            spec: testExtractionSpec,
            entityName: "Anthropic",
            sourceUrl: secondUrl,
            quote: "Anthropic evidence",
          }),
        ],
      },
    }),
  });

  assert.equal(result.rows.length, 1);
});

test("populate runtime asks for insurance quote inputs without running populate", async () => {
  const result = await runPopulateRuntime({
    context: {
      ...context,
      description:
        "find me the best car insurance prices in California so I can pick the best bang for my buck",
    },
  });

  assert.deepEqual(result.rows, []);
  assert.equal(result.metrics.fetchCalls, 0);
  assert.match(result.validationIssues.join(" "), /driver/);
});

test("populate runtime asks for AI company scope without running populate", async () => {
  const result = await runPopulateRuntime({
    context: {
      ...context,
      description: "get me the latest stuff from the big AI companies",
    },
  });

  assert.deepEqual(result.rows, []);
  assert.equal(result.metrics.fetchCalls, 0);
});

test("search acquisition enforces search call budget", async () => {
  const metrics = emptyMetrics();
  await runSearchAcquisitionPhase({
    context,
    dataSpec: mockPopulateDataSpec(1),
    maxSearchCalls: 1,
    webTools: {
      search: async () => [
        { title: "A", url: "https://example.com/a" },
      ],
      fetch: async () => ({}),
    },
    metrics,
    validationIssues: [],
    debugNotes: [],
    searchAcquisitionRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { error?: string }
      >;
      await searchWeb.execute({ query: "first" });
      const blocked = await searchWeb.execute({ query: "second" });
      assert.match(blocked.error ?? "", /Search budget/);
      return {
        object: {
          scored_urls: [
            { url: "https://example.com/a", expectation_score: 5 },
          ],
        },
      };
    },
  });

  assert.equal(metrics.searchCalls, 1);
  assert.equal(metrics.agentRuns, 1);
});

test("search acquisition scores every pooled search result", async () => {
  const metrics = emptyMetrics();
  const phase = await runSearchAcquisitionPhase({
    context,
    dataSpec: mockPopulateDataSpec(10),
    maxSearchCalls: 10,
    webTools: {
      search: async () => [
        { title: "A", url: "https://example.com/a" },
        { title: "B", url: "https://example.com/b" },
      ],
      fetch: async () => ({}),
    },
    metrics,
    validationIssues: [],
    debugNotes: [],
    searchAcquisitionRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<{ query: string }, unknown>;
      await searchWeb.execute({ query: "first" });
      return {
        object: {
          scored_urls: [
            { url: "https://example.com/a", expectation_score: 5 },
            { url: "https://example.com/b", expectation_score: 2 },
          ],
        },
      };
    },
  });

  assert.equal(metrics.searchCalls, 1);
  assert.equal(metrics.agentRuns, 1);
  assert.equal(phase.scoredUrls.length, 2);
});

test("populate runtime fetches each prioritized URL in worker shards", async () => {
  const urls = {
    high: "https://example.com/high",
    low: "https://example.com/low",
  };

  const result = await runPopulateRuntime({
    context,
    dataSpec: testDataSpec,
    maxFetchCalls: 1,
    acquisition: mockAcquisition({
      fetchLimit: 1,
      results: [
        { url: urls.high, expectation_score: 5 },
        { url: urls.low, expectation_score: 1 },
      ],
    }),
    webTools: {
      search: async () => [],
      fetch: async ({ url }) => ({
        title: url,
        text: `content for ${url}`,
      }),
    },
    populateHooks: mockTriageExtractHooks({
      recordsByUrl: {
        [urls.high]: [
          buildMockRow({
            spec: testExtractionSpec,
            entityName: "High",
            sourceUrl: urls.high,
            quote: "content for high",
          }),
        ],
      },
    }),
  });

  assert.equal(result.metrics.fetchCalls, 1);
  assert.equal(result.rows.length, 1);
});

test("populate runtime normalizes URLs when fetching prioritized pages", async () => {
  const normalized = normalizeSearchResultUrl("https://openai.com/news");
  const result = await runPopulateRuntime({
    context,
    dataSpec: testDataSpec,
    acquisition: mockAcquisition({
      results: [{ url: "https://openai.com/news/" }],
    }),
    webTools: {
      search: async () => [],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes",
      }),
    },
    populateHooks: mockTriageExtractHooks({
      recordsByUrl: {
        [normalized]: [
          buildMockRow({
            spec: testExtractionSpec,
            entityName: "OpenAI",
            sourceUrl: normalized,
            quote: "Release notes",
          }),
        ],
      },
    }),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.metrics.fetchCalls, 1);
});

test("populate runtime runs parallel populate for explicit blog post requests", async () => {
  const result = await runPopulateRuntime({
    context: {
      ...context,
      description:
        "Can you make me a table of the latest blog posts from OpenAI, Anthropic, and Google DeepMind?",
    },
    dataSpec: testDataSpec,
    acquisition: mockAcquisition({ results: [] }),
    webTools: {
      search: async () => [],
      fetch: async () => ({}),
    },
    populateHooks: mockTriageExtractHooks({ recordsByUrl: {} }),
  });

  assert.equal(result.metrics.fetchCalls, 0);
  assert.deepEqual(result.rows, []);
});
