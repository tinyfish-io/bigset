import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureScoredUrlsAsSources,
  finalizeAcquisitionResult,
  runSearchAcquisitionPhase,
} from "../src/pipeline/populate-acquisition.js";
import { normalizeSearchResultUrl } from "../src/pipeline/populate-search-prioritization.js";
import type { DatasetSchema } from "../src/pipeline/types.js";

function mockAcquisitionDataSpec(queryCount: number): DatasetSchema {
  return {
    dataset_name: "acquisition_test",
    description: "Find one official page.",
    primary_key: "source_url",
    search_queries: Array.from(
      { length: queryCount },
      (_, index) => `seed query ${index + 1}`
    ),
    columns: [
      {
        name: "source_url",
        display_name: "Source URL",
        type: "url",
        is_primary_key: true,
        is_enumerable: true,
        description: "Official page URL.",
        nullable: false,
      },
    ],
  };
}

test("finalize acquisition applies fetch limit to scored URLs", async () => {
  const metrics = {
    searchCalls: 0,
    fetchCalls: 0,
    browserCalls: 0,
    agentRuns: 0,
    agentSteps: 0,
  };

  const phase = await runSearchAcquisitionPhase({
    context: {
      datasetId: "acquisition-test",
      datasetName: "acquisition_test",
      description: "Find one official page.",
      columns: [{ name: "source_url", type: "url" }],
    },
    maxSearchCalls: 10,
    dataSpec: mockAcquisitionDataSpec(5),
    webTools: {
      search: async () => [
        { title: "High", url: "https://example.com/high", snippet: "high" },
        { title: "Low", url: "https://example.com/low", snippet: "low" },
      ],
      fetch: async () => ({}),
    },
    metrics,
    validationIssues: [],
    debugNotes: [],
    searchAcquisitionRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as {
        execute(input: { query: string }): Promise<unknown>;
      };
      await searchWeb.execute({ query: "test" });
      return {
        object: {
          scored_urls: [
            { url: "https://example.com/high", expectation_score: 5 },
            { url: "https://example.com/low", expectation_score: 1 },
          ],
        },
      };
    },
  });

  const acquisition = finalizeAcquisitionResult(phase, 1);
  const capturedSources = captureScoredUrlsAsSources(
    acquisition.scoredUrls.filter((entry) =>
      acquisition.prioritizedUrls.includes(normalizeSearchResultUrl(entry.url))
    )
  );

  assert.equal(acquisition.prioritizedUrls.length, 1);
  assert.equal(
    normalizeSearchResultUrl(acquisition.prioritizedUrls[0] ?? ""),
    "https://example.com/high"
  );
  assert.equal(capturedSources.length, 1);
  assert.match(capturedSources[0]?.text ?? "", /search_query: test/);
  assert.equal(acquisition.scoredUrls.length, 2);
  assert.equal(acquisition.scoredUrls[0]?.url, "https://example.com/high");
  assert.equal(acquisition.scoredUrls[0]?.search_query, "test");
});
