import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isPopulateBenchmarkDebugEnabled,
  writePopulateBenchmarkDebugArtifacts,
} from "../src/pipeline/populate-benchmark-debug.js";

test("isPopulateBenchmarkDebugEnabled reads POPULATE_BENCHMARK_DEBUG", () => {
  assert.equal(isPopulateBenchmarkDebugEnabled({}), false);
  assert.equal(
    isPopulateBenchmarkDebugEnabled({ POPULATE_BENCHMARK_DEBUG: "true" }),
    true
  );
  assert.equal(
    isPopulateBenchmarkDebugEnabled({ POPULATE_BENCHMARK_DEBUG: "0" }),
    false
  );
});

test("writePopulateBenchmarkDebugArtifacts writes debug json and csv files", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "populate-debug-"));
  await writePopulateBenchmarkDebugArtifacts(artifactDirectory, {
    runAt: "2026-05-23T00:00:00.000Z",
    context: {
      datasetId: "benchmark-test",
      datasetName: "benchmark_test",
      description: "Test dataset.",
      columns: [{ name: "entity_name", type: "text" }],
    },
    limits: { maxRows: 10, maxSearchCalls: 5, maxFetchCalls: 20 },
    searchPool: [
      {
        search_query: "yc companies",
        title: "YC",
        url: "https://example.com/yc",
      },
    ],
    acquisition: {
      initialQueries: ["yc companies"],
      validationIssues: [],
      scoredUrls: [
        {
          url: "https://example.com/yc",
          expectation_score: 5,
          search_query: "yc companies",
        },
      ],
      prioritizedUrls: ["https://example.com/yc"],
    },
    populatePromptUrlCount: 1,
    capturedSources: [{ url: "https://example.com/yc", text: "YC batch" }],
    capturedRows: [],
    validationIssues: [],
    metrics: {
      searchCalls: 1,
      fetchCalls: 1,
      browserCalls: 0,
      agentRuns: 2,
      agentSteps: 0,
    },
    notes: ["test note"],
  });

  const report = JSON.parse(
    await readFile(join(artifactDirectory, "debug", "run_report.json"), "utf8")
  );
  assert.equal(report.counts.searchPool, 1);
  assert.equal(report.counts.prioritizedUrls, 1);

  const prioritizedCsv = await readFile(
    join(artifactDirectory, "debug", "prioritized_urls.csv"),
    "utf8"
  );
  assert.match(prioritizedCsv, /https:\/\/example.com\/yc/);
});
