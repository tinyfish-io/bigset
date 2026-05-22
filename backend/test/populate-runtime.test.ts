import assert from "node:assert/strict";
import { test } from "node:test";

import { runPopulateRuntime } from "../src/pipeline/populate-runtime.js";

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

test("populate runtime captures rows through injected tools without Convex writes", async () => {
  const result = await runPopulateRuntime({
    context,
    webTools: {
      search: async () => [
        {
          title: "OpenAI news",
          snippet: "Release notes",
          url: "https://openai.com/news",
        },
      ],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes",
      }),
    },
    agentRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { results?: unknown[] }
      >;
      const fetchPage = tools.fetch_page as ToolLike<
        { url: string },
        { text?: string }
      >;
      const insertRow = tools.insert_row as ToolLike<
        { datasetId: string; data: Record<string, unknown> },
        { success: boolean }
      >;

      const search = await searchWeb.execute({ query: "OpenAI latest blog" });
      assert.equal(search.results?.length, 1);
      const page = await fetchPage.execute({ url: "https://openai.com/news" });
      assert.match(page.text ?? "", /Release notes/);
      const inserted = await insertRow.execute({
        datasetId: "benchmark-dataset",
        data: {
          entity_name: "OpenAI",
          latest_post_title: "Release notes",
          source_url: "https://openai.com/news",
          evidence_quote: "Release notes",
        },
      });
      assert.equal(inserted.success, true);
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
  assert.deepEqual(result.rows[0]?.sourceUrls, ["https://openai.com/news"]);
  assert.equal(result.rows[0]?.evidence[0]?.quote, "Release notes");
  assert.equal(result.metrics.searchCalls, 1);
  assert.equal(result.metrics.fetchCalls, 1);
  assert.equal(result.metrics.agentRuns, 1);
  assert.deepEqual(result.validationIssues, []);
});

test("populate runtime enforces per-run row cap before inserting", async () => {
  const result = await runPopulateRuntime({
    context,
    maxRows: 1,
    webTools: {
      search: async () => [],
      fetch: async () => ({}),
    },
    agentRunner: async ({ tools }) => {
      const insertRow = tools.insert_row as ToolLike<
        { datasetId: string; data: Record<string, unknown> },
        { success: boolean; error?: string }
      >;

      const first = await insertRow.execute({
        datasetId: "benchmark-dataset",
        data: {
          entity_name: "OpenAI",
          source_url: "https://openai.com/news",
          evidence_quote: "Release notes",
        },
      });
      const second = await insertRow.execute({
        datasetId: "benchmark-dataset",
        data: {
          entity_name: "Anthropic",
          source_url: "https://anthropic.com/news",
          evidence_quote: "News",
        },
      });

      assert.equal(first.success, true);
      assert.equal(second.success, false);
      assert.match(second.error ?? "", /Row cap/);
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
});
