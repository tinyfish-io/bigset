import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserActionBox } from "../src/pipeline/populate-browser-action-box.js";
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

test("populate runtime strips unbacked insert_row evidence before validation", async () => {
  const result = await runPopulateRuntime({
    context,
    webTools: {
      search: async () => [],
      fetch: async () => ({}),
    },
    agentRunner: async ({ tools }) => {
      const insertRow = tools.insert_row as ToolLike<
        { datasetId: string; data: Record<string, unknown> },
        { success: boolean }
      >;

      await insertRow.execute({
        datasetId: "benchmark-dataset",
        data: {
          entity_name: "OpenAI",
          latest_post_title: "Invented post",
          source_url: "https://openai.com/news",
          evidence_quote: "Invented quote never fetched",
        },
      });
    },
  });

  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0]?.evidence, []);
  assert.match(
    result.validationIssues.join("\n"),
    /evidence quotes/i
  );
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

test("populate runtime can pre-rank and fetch planned sources before agent work", async () => {
  const calls: string[] = [];
  const result = await runPopulateRuntime({
    context,
    sourcePlanner: {
      enabled: true,
      fetchLimit: 1,
    },
    webTools: {
      search: async ({ query }) => {
        calls.push(`search:${query}`);
        return [
          {
            title: "Forum copy",
            snippet: "OpenAI pricing discussion",
            url: "https://reddit.com/r/openai/comments/pricing",
          },
          {
            title: "OpenAI API Pricing",
            snippet: "Official API pricing page.",
            url: "https://openai.com/api/pricing",
          },
        ];
      },
      fetch: async ({ url }) => {
        calls.push(`fetch:${url}`);
        return {
          title: "OpenAI API Pricing",
          text: "Official API pricing page.",
        };
      },
    },
    agentRunner: async () => ({
      rows: [{
        cells: {
          entity_name: "OpenAI",
          latest_post_title: "OpenAI API Pricing",
          source_url: "https://openai.com/api/pricing",
          evidence_quote: "Official API pricing page.",
        },
        sourceUrls: ["https://openai.com/api/pricing"],
        evidence: [{
          columnName: "latest_post_title",
          sourceUrl: "https://openai.com/api/pricing",
          quote: "Official API pricing page.",
        }],
      }],
    }),
  });

  assert.ok(calls.some((call) => call.startsWith("search:")));
  assert.deepEqual(
    calls.filter((call) => call.startsWith("fetch:")),
    ["fetch:https://openai.com/api/pricing"]
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.metrics.searchCalls, 1);
  assert.equal(result.metrics.fetchCalls, 1);
  assert.ok(result.debug?.processTrace.steps.some((step) =>
    step.label === "source-planner-search"
  ));
});

test("populate runtime plans searches from user prompt before durable recipe instructions", async () => {
  const searchQueries: string[] = [];

  await runPopulateRuntime({
    context: {
      ...context,
      description: [
        "nyc big techs that are hiring",
        "",
        "Durable recipe instructions:",
        "Use search_web before fetch_page unless an official source URL is already obvious.",
        "Prefer official docs, pricing, blog, product, or company pages over third-party summaries.",
      ].join("\n"),
      columns: [
        {
          name: "Company Name",
          type: "text",
          description: "The official name of the big tech company.",
        },
        {
          name: "Careers Page URL",
          type: "url",
          description: "Direct URL to the company's careers page.",
          nullable: true,
        },
      ],
    },
    sourcePlanner: {
      enabled: true,
      fetchLimit: 0,
    },
    webTools: {
      search: async ({ query }) => {
        searchQueries.push(query);
        return [];
      },
      fetch: async () => {
        throw new Error("fetch should not run with fetchLimit 0");
      },
    },
    agentRunner: async () => ({ rows: [] }),
  });

  assert.deepEqual(searchQueries, [
    "nyc big techs that are hiring official source",
  ]);
});

test("populate runtime calls BrowserActionBox for browser-heavy fetched sources", async () => {
  let browserActionBoxCalls = 0;
  const browserActionBox = new BrowserActionBox({
    tinyFishClient: {
      async runAgent() {
        browserActionBoxCalls += 1;
        return {
          runId: "run-browser-heavy",
          status: "COMPLETED",
          runDetail: {
            run_id: "run-browser-heavy",
            status: "COMPLETED",
            steps: [{
              action: "navigate",
              status: "completed",
              url: "https://example.com/locator",
            }, {
              action: "type",
              status: "completed",
              target_text: "Search",
              value: "OpenAI",
              url: "https://example.com/locator",
            }],
          },
          finalResult: {
            records: [{
              entity_name: "OpenAI",
              latest_post_title: "OpenAI locator result",
              source_url: "https://example.com/locator",
              evidence_quote: "OpenAI locator result",
              evidence: [{
                field: "latest_post_title",
                url: "https://example.com/locator",
                quote: "OpenAI locator result",
              }],
            }],
            agent_browser_actions: [{
              action: "type",
              url: "https://example.com/locator",
              target_text: "Search",
              value_description: "redacted typed value",
            }],
          },
        };
      },
    },
  });

  const result = await runPopulateRuntime({
    context,
    browserActionBox,
    sourcePlanner: {
      enabled: true,
      fetchLimit: 1,
    },
    webTools: {
      search: async () => [
        {
          title: "Example locator",
          snippet: "Search and filter current entries.",
          url: "https://example.com/locator",
        },
      ],
      fetch: async () => ({
        title: "Example locator",
        text: "Enter your search term and submit the form to see current entries.",
      }),
    },
    agentRunner: async () => ({ rows: [] }),
  });

  assert.equal(browserActionBoxCalls, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.latest_post_title, "OpenAI locator result");
  assert.ok(result.debug?.processTrace.steps.some((step) =>
    step.label === "tinyfish-agent-run"
  ));
  assert.ok(result.debug?.diagnosticArtifacts?.some((artifact) =>
    artifact.kind === "tinyfish-trace"
  ));
});

test("populate runtime builds simple title URL rows from captured sources", async () => {
  const result = await runPopulateRuntime({
    context: {
      datasetId: "product-releases",
      datasetName: "OpenAI product releases",
      description:
        "find OpenAI product release articles from https://openai.com/news/product-releases/ with post title and post URL",
      columns: [
        {
          name: "Post Title",
          type: "text" as const,
          description: "Post title.",
        },
        {
          name: "Post URL",
          type: "url" as const,
          description: "Post URL.",
        },
      ],
    },
    webTools: {
      search: async () => [
        {
          title: "OpenAI Newsroom | Product",
          snippet: "Product release listing page.",
          url: "https://openai.com/news/product-releases/",
        },
        {
          title: "Introducing GPT-5",
          snippet: "OpenAI product release post.",
          url: "https://openai.com/index/introducing-gpt-5/",
        },
      ],
      fetch: async () => ({
        title: "OpenAI Newsroom | Product",
        text: "Product release listing page.",
      }),
    },
    agentRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { results?: unknown[] }
      >;
      await searchWeb.execute({ query: "OpenAI product releases" });
      return {
        rows: [{
          cells: {
            "Post Title": "OpenAI Newsroom | Product",
            "Post URL": "https://openai.com/news/product-releases/",
          },
          sourceUrls: ["https://openai.com/news/product-releases/"],
          evidence: [{
            columnName: "Post Title",
            sourceUrl: "https://openai.com/news/product-releases/",
            quote: "OpenAI Newsroom | Product",
          }],
        }],
        validationIssues: [
          "Individual article URLs are not present in the transcript; only the listing page URL is available.",
        ],
      };
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells["Post Title"], "Introducing GPT-5");
  assert.equal(
    result.rows[0]?.cells["Post URL"],
    "https://openai.com/index/introducing-gpt-5/"
  );
  assert.deepEqual(result.validationIssues, []);
});

test("populate runtime shortcuts explicit URL title rows without agent call", async () => {
  let agentCalls = 0;
  const result = await runPopulateRuntime({
    context: {
      datasetId: "docs-pages",
      datasetName: "OpenAI API docs pages",
      description:
        "make a table from these public OpenAI API docs pages with only page title and page URL: https://developers.openai.com/api/docs/mcp",
      columns: [
        {
          name: "Page URL",
          type: "url" as const,
          description: "Page URL.",
        },
        {
          name: "Page Title",
          type: "text" as const,
          description: "Page title.",
        },
      ],
    },
    webTools: {
      search: async () => [],
      fetch: async () => ({
        title: "Building MCP servers for ChatGPT Apps and API integrations",
        text: "Building MCP servers for ChatGPT Apps and API integrations\nMCP and Connectors",
      }),
    },
    agentRunner: async () => {
      agentCalls += 1;
    },
  });

  assert.equal(agentCalls, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(
    result.rows[0]?.cells["Page Title"],
    "Building MCP servers for ChatGPT Apps and API integrations"
  );
  assert.equal(
    result.rows[0]?.cells["Page URL"],
    "https://developers.openai.com/api/docs/mcp"
  );
  assert.deepEqual(result.validationIssues, []);
  assert.equal(result.metrics.agentRuns, 0);
});

test("populate runtime does not build deterministic rows outside explicit URL scope", async () => {
  const result = await runPopulateRuntime({
    context: {
      datasetId: "product-releases",
      datasetName: "OpenAI product releases",
      description:
        "find OpenAI product release articles from https://openai.com/news/product-releases/ with post title and post URL",
      columns: [
        {
          name: "Post Title",
          type: "text" as const,
          description: "Post title.",
        },
        {
          name: "Post URL",
          type: "url" as const,
          description: "Post URL.",
        },
      ],
    },
    webTools: {
      search: async () => [
        {
          title: "Building MCP servers for ChatGPT Apps and API integrations",
          snippet: "OpenAI developer docs.",
          url: "https://developers.openai.com/api/docs/mcp",
        },
      ],
      fetch: async (input) => {
        if (input.url === "https://openai.com/news/product-releases/") {
          throw new Error("fetch failed");
        }
        return {
          title: "Building MCP servers for ChatGPT Apps and API integrations",
          text: "Building MCP servers for ChatGPT Apps and API integrations",
        };
      },
    },
    agentRunner: async ({ tools }) => {
      const searchWeb = tools.search_web as ToolLike<
        { query: string },
        { results?: unknown[] }
      >;
      await searchWeb.execute({ query: "OpenAI product releases" });
      return {
        rows: [{
          cells: {
            "Post Title": "OpenAI Newsroom | Product",
            "Post URL": "https://openai.com/news/product-releases/",
          },
          sourceUrls: ["https://openai.com/news/product-releases/"],
          evidence: [{
            columnName: "Post Title",
            sourceUrl: "https://openai.com/news/product-releases/",
            quote: "OpenAI Newsroom | Product",
          }],
        }],
        validationIssues: [
          "Individual article URLs are not present in the transcript; only the listing page URL is available.",
        ],
      };
    },
  });

  assert.equal(result.rows.length, 0);
  assert.match(
    result.validationIssues.join("\n"),
    /Mastra populate runtime returned no rows/
  );
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
    result.debug?.notes.join("\n") ?? "",
    /Structured row recovery replaced insert_row rows/
  );
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
