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

test("populate runtime accepts structured fallback rows backed by captured sources", async () => {
  const result = await runPopulateRuntime({
    context,
    webTools: {
      search: async () => [
        {
          title: "OpenAI news",
          snippet: "Release notes from OpenAI",
          url: "https://openai.com/news",
        },
      ],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes from OpenAI",
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

      await searchWeb.execute({ query: "OpenAI latest blog" });
      await fetchPage.execute({ url: "https://openai.com/news" });

      return {
        rows: [{
          cells: {
            entity_name: "OpenAI",
            latest_post_title: "Release notes",
            source_url: "https://openai.com/news",
            evidence_quote: "Release notes from OpenAI",
          },
          sourceUrls: ["https://openai.com/news"],
          evidence: [{
            columnName: "latest_post_title",
            sourceUrl: "https://openai.com/news",
            quote: "Release notes from OpenAI",
          }],
        }],
      };
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
  assert.equal(result.rows[0]?.needsReview, true);
  assert.deepEqual(result.rows[0]?.sourceUrls, ["https://openai.com/news"]);
  assert.deepEqual(result.validationIssues, []);
});

test("populate runtime rejects structured fallback rows without source-backed evidence", async () => {
  const result = await runPopulateRuntime({
    context,
    webTools: {
      search: async () => [
        {
          title: "OpenAI news",
          snippet: "Release notes from OpenAI",
          url: "https://openai.com/news",
        },
      ],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes from OpenAI",
      }),
    },
    agentRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { results?: unknown[] }
      >;

      await searchWeb.execute({ query: "OpenAI latest blog" });

      return {
        rows: [{
          cells: {
            entity_name: "OpenAI",
            latest_post_title: "Invented post",
            source_url: "https://openai.com/news",
            evidence_quote: "Invented quote",
          },
          sourceUrls: ["https://openai.com/news"],
          evidence: [{
            columnName: "latest_post_title",
            sourceUrl: "https://openai.com/news",
            quote: "Invented quote",
          }],
        }],
      };
    },
  });

  assert.equal(result.rows.length, 0);
  assert.match(result.validationIssues.join("\n"), /evidence quote not found/);
  assert.match(result.validationIssues.join("\n"), /returned no rows/);
});

test("populate runtime prefers insert_row captures over contradictory structured rows", async () => {
  const result = await runPopulateRuntime({
    context,
    webTools: {
      search: async () => [
        {
          title: "OpenAI news",
          snippet: "Release notes from OpenAI",
          url: "https://openai.com/news",
        },
      ],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes from OpenAI",
      }),
    },
    agentRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { results?: unknown[] }
      >;
      const insertRow = tools.insert_row as ToolLike<
        { datasetId: string; data: Record<string, unknown> },
        { success: boolean }
      >;

      await searchWeb.execute({ query: "OpenAI latest blog" });
      await insertRow.execute({
        datasetId: "benchmark-dataset",
        data: {
          entity_name: "OpenAI",
          latest_post_title: "Release notes",
          source_url: "https://openai.com/news",
          evidence_quote: "Release notes from OpenAI",
        },
      });

      return {
        rows: [{
          cells: {
            entity_name: "Different",
            latest_post_title: "Release notes",
            source_url: "https://openai.com/news",
            evidence_quote: "Release notes from OpenAI",
          },
          sourceUrls: ["https://openai.com/news"],
          evidence: [{
            columnName: "latest_post_title",
            sourceUrl: "https://openai.com/news",
            quote: "Release notes from OpenAI",
          }],
        }],
      };
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
  assert.match(result.validationIssues.join("\n"), /Structured populate rows differed/);
});

test("populate runtime uses structured recovery when insert_row rows lack evidence", async () => {
  const result = await runPopulateRuntime({
    context,
    webTools: {
      search: async () => [
        {
          title: "OpenAI news",
          snippet: "Release notes from OpenAI",
          url: "https://openai.com/news",
        },
      ],
      fetch: async () => ({
        title: "OpenAI news",
        text: "Release notes from OpenAI",
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

      await searchWeb.execute({ query: "OpenAI latest blog" });
      await fetchPage.execute({ url: "https://openai.com/news" });
      await insertRow.execute({
        datasetId: "benchmark-dataset",
        data: {
          entity_name: "OpenAI",
          latest_post_title: "Release notes",
          source_url: "https://openai.com/news",
          evidence_quote: "",
        },
      });

      return {
        rows: [{
          cells: {
            entity_name: "OpenAI",
            latest_post_title: "Release notes",
            source_url: "https://openai.com/news",
            evidence_quote: "Release notes from OpenAI",
          },
          sourceUrls: ["https://openai.com/news"],
          evidence: [{
            columnName: "latest_post_title",
            sourceUrl: "https://openai.com/news",
            quote: "Release notes from OpenAI",
          }],
        }],
      };
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.evidence[0]?.quote, "Release notes from OpenAI");
  assert.match(
    result.validationIssues.join("\n"),
    /Structured row recovery replaced insert_row rows/
  );
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

test("populate runtime asks for insurance quote inputs without running the agent", async () => {
  let wasAgentRunnerCalled = false;
  const result = await runPopulateRuntime({
    context: {
      ...context,
      description:
        "find me the best car insurance prices in California so I can pick the best bang for my buck",
    },
    webTools: {
      search: async () => {
        throw new Error("search should not run");
      },
      fetch: async () => {
        throw new Error("fetch should not run");
      },
    },
    agentRunner: async () => {
      wasAgentRunnerCalled = true;
    },
  });

  assert.equal(wasAgentRunnerCalled, false);
  assert.deepEqual(result.rows, []);
  assert.equal(result.metrics.agentRuns, 0);
  assert.equal(result.metrics.searchCalls, 0);
  assert.equal(result.metrics.fetchCalls, 0);
  assert.match(result.validationIssues.join(" "), /driver/);
  assert.match(result.validationIssues.join(" "), /vehicle/);
  assert.match(result.validationIssues.join(" "), /zip/);
  assert.match(result.validationIssues.join(" "), /coverage/);
  assert.match(result.validationIssues.join(" "), /deductible/);
});

test("populate runtime asks for AI company scope without running the agent", async () => {
  let wasAgentRunnerCalled = false;
  const result = await runPopulateRuntime({
    context: {
      ...context,
      description: "get me the latest stuff from the big AI companies",
    },
    webTools: {
      search: async () => {
        throw new Error("search should not run");
      },
      fetch: async () => {
        throw new Error("fetch should not run");
      },
    },
    agentRunner: async () => {
      wasAgentRunnerCalled = true;
    },
  });

  assert.equal(wasAgentRunnerCalled, false);
  assert.deepEqual(result.rows, []);
  assert.equal(result.metrics.agentRuns, 0);
  assert.equal(result.metrics.searchCalls, 0);
  assert.equal(result.metrics.fetchCalls, 0);
  assert.match(result.validationIssues.join(" "), /which companies/);
  assert.match(result.validationIssues.join(" "), /source type/);
  assert.match(result.validationIssues.join(" "), /news/);
  assert.match(result.validationIssues.join(" "), /blog/);
  assert.match(result.validationIssues.join(" "), /release/);
  assert.match(result.validationIssues.join(" "), /columns/);
});

test("populate runtime does not preflight explicit latest blog post requests", async () => {
  let wasAgentRunnerCalled = false;
  const result = await runPopulateRuntime({
    context: {
      ...context,
      description:
        "Can you make me a table of the latest blog posts from OpenAI, Anthropic, and Google DeepMind?",
    },
    webTools: {
      search: async () => [],
      fetch: async () => ({}),
    },
    agentRunner: async () => {
      wasAgentRunnerCalled = true;
    },
  });

  assert.equal(wasAgentRunnerCalled, true);
  assert.equal(result.metrics.agentRuns, 1);
});
