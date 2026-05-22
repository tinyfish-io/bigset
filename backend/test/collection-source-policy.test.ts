import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPromptSourcePolicyToSpec,
  applyPromptSourcePolicyToTriageResult,
  derivePromptSourcePolicy,
  promptSourceSearchQueries,
  recordMatchesPromptSourcePolicy,
  sourceCandidatePolicyBoost,
  urlMatchesPromptSourcePolicy,
} from "../BigSet_Data_Collection_Agent/src/agents/source-policy.js";
import type {
  DatasetSpec,
  ExtractedRecord,
  SourceCandidate,
  SourceTriageResult,
} from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

test("prompt source policy derives official queries from the user's prompt", () => {
  const policy = derivePromptSourcePolicy(
    "For Stripe, Paddle, and Chargebee, collect the official pricing page URL and the plan names or starting prices shown on the page.",
  );

  assert.equal(policy.requiresOfficialSource, true);
  assert.deepEqual(
    policy.entities.map((entity) => entity.name),
    ["Stripe", "Paddle", "Chargebee"],
  );
  assert.deepEqual(promptSourceSearchQueries(policy).slice(0, 3), [
    "Stripe official pricing page",
    "Stripe billing pricing",
    "Paddle official pricing page",
  ]);
});

test("prompt source policy ignores generic durable recipe source wording", () => {
  const policy = derivePromptSourcePolicy(
    [
      "Dataset: benchmark_latest-ai-blog-posts",
      "Task: Can you make me a table of the latest blog posts from OpenAI, Anthropic, and Google DeepMind? I need title, publish date, and URL.",
      "",
      "Durable recipe instructions:",
      "Prefer official docs, pricing, blog, product, or company pages over third-party summaries.",
    ].join("\n"),
  );

  const queries = promptSourceSearchQueries(policy);

  assert.deepEqual(queries, [
    "OpenAI official blog latest post",
    "Anthropic official blog latest post",
    "Google DeepMind official blog latest post",
  ]);
});

test("prompt source policy adds official-source guidance without benchmark answer keys", () => {
  const spec: DatasetSpec = {
    intent_summary: "Collect pricing pages.",
    target_row_count: 3,
    row_grain: "one row per company",
    columns: [
      {
        name: "entity_name",
        type: "string",
        description: "Company.",
        required: true,
      },
      {
        name: "pricing_page_url",
        type: "string",
        description: "Official pricing URL.",
        required: true,
      },
    ],
    dedupe_keys: ["entity_name"],
    search_queries: ["SaaS pricing pages"],
    extraction_hints: "Extract plan names.",
  };

  const updated = applyPromptSourcePolicyToSpec(
    spec,
    "For Stripe and Paddle, collect the official pricing page URL.",
  );

  assert.equal(updated.search_queries[0], "Stripe official pricing page");
  assert.equal(updated.search_queries[1], "Stripe billing pricing");
  assert.equal(updated.search_queries[2], "Paddle official pricing page");
  assert.match(updated.extraction_hints, /Prompt source policy/);
  assert.match(updated.extraction_hints, /Stripe, Paddle/);
});

test("prompt source policy prefers entity-owned domains over third-party proof", () => {
  const policy = derivePromptSourcePolicy(
    "Find the latest investor relations earnings release page for Apple, Microsoft, and Nvidia.",
  );

  assert.equal(
    urlMatchesPromptSourcePolicy("https://investor.apple.com/newsroom/", policy),
    true,
  );
  assert.equal(
    urlMatchesPromptSourcePolicy("https://finance.yahoo.com/quote/AAPL", policy),
    false,
  );
  assert.equal(
    urlMatchesPromptSourcePolicy("https://cloud.google.com/blog/topics/threat-intelligence", {
      ...derivePromptSourcePolicy(
        "Can you make me a table of the latest blog posts from OpenAI, Anthropic, and Google DeepMind?",
      ),
    }),
    false,
  );
  assert.equal(
    urlMatchesPromptSourcePolicy(
      "https://openai.github.io/openai-agents-python/mcp/",
      derivePromptSourcePolicy(
        "I need official docs pages for setting up MCP servers from Anthropic, OpenAI, and Cloudflare.",
      ),
    ),
    false,
  );
});

test("prompt source policy downgrades third-party extraction triage", () => {
  const policy = derivePromptSourcePolicy(
    "For Stripe, Paddle, and Chargebee, collect the official pricing page URL and plan names.",
  );
  const triage: SourceTriageResult = {
    url: "https://www.trustradius.com/products/paddle/pricing",
    final_url: "https://www.trustradius.com/products/paddle/pricing",
    title: "Paddle Pricing",
    status: "extract_now",
    confidence: 0.9,
    source_data_confidence: 0.8,
    expected_yield: "complete",
    reasoning: "Page lists pricing information.",
  };

  const updated = applyPromptSourcePolicyToTriageResult(triage, policy);

  assert.equal(updated.status, "low_value");
  assert.equal(updated.expected_yield, "none");
  assert.match(updated.reasoning, /official\/canonical sources/);
});

test("prompt source policy boosts official candidates", () => {
  const policy = derivePromptSourcePolicy(
    [
      "Dataset: benchmark_mcp-docs-pages",
      "Task: I need official docs pages for setting up MCP servers from Anthropic, OpenAI, and Cloudflare. Give me title, URL, and what each page covers.",
      "",
      "Durable recipe instructions:",
      "Prefer official docs, pricing, blog, product, or company pages over third-party summaries.",
    ].join("\n"),
  );
  assert.deepEqual(
    policy.entities.map((entity) => entity.name),
    ["Anthropic", "OpenAI", "Cloudflare"],
  );
  assert.deepEqual(promptSourceSearchQueries(policy).slice(0, 4), [
    "Anthropic MCP connector docs site:platform.claude.com",
    "OpenAI MCP connector docs site:developers.openai.com",
    "Cloudflare MCP connector docs site:developers.cloudflare.com",
    "Anthropic MCP connector docs",
  ]);
  const official: SourceCandidate = {
    url: "https://developers.cloudflare.com/agents/model-context-protocol/",
    title: "MCP servers",
    snippet: "Official Cloudflare docs for MCP server setup.",
    query: "Cloudflare official docs MCP server setup",
  };
  const thirdParty: SourceCandidate = {
    url: "https://example.com/cloudflare-mcp-guide",
    title: "Cloudflare MCP guide",
    snippet: "A blog guide to Cloudflare MCP.",
    query: "Cloudflare official docs MCP server setup",
  };

  assert.ok(
    sourceCandidatePolicyBoost(official, policy) >
      sourceCandidatePolicyBoost(thirdParty, policy),
  );
});

test("prompt source policy prefers docs surfaces over blogs, courses, and directories", () => {
  const policy = derivePromptSourcePolicy(
    "I need official docs pages for setting up MCP servers from Anthropic, OpenAI, and Cloudflare.",
  );
  const docs: SourceCandidate = {
    url: "https://platform.claude.com/docs/en/agents-and-tools/mcp-connector",
    title: "Model Context Protocol connector",
    snippet: "Official Anthropic documentation for MCP connector setup.",
    query: "Anthropic MCP connector docs",
  };
  const course: SourceCandidate = {
    url: "https://anthropic.skilljar.com/introduction-to-model-context-protocol",
    title: "Introduction to Model Context Protocol",
    snippet: "Anthropic course for learning MCP.",
    query: "Anthropic MCP connector docs",
  };
  const blog: SourceCandidate = {
    url: "https://blog.cloudflare.com/code-mode/",
    title: "Code Mode: the better way to use MCP",
    snippet: "Cloudflare blog post about MCP.",
    query: "Cloudflare MCP connector docs",
  };
  const cloudflareDocs: SourceCandidate = {
    url: "https://developers.cloudflare.com/agents/model-context-protocol/",
    title: "Model Context Protocol",
    snippet: "Official Cloudflare docs for MCP servers.",
    query: "Cloudflare MCP connector docs",
  };

  assert.ok(
    sourceCandidatePolicyBoost(docs, policy) >
      sourceCandidatePolicyBoost(course, policy),
  );
  assert.equal(
    urlMatchesPromptSourcePolicy(
      "https://platform.claude.com/docs/en/agents-and-tools/mcp-connector",
      policy,
    ),
    true,
  );
  assert.ok(
    sourceCandidatePolicyBoost(cloudflareDocs, policy) >
      sourceCandidatePolicyBoost(blog, policy),
  );
});

test("prompt source policy rejects records sourced from another entity's docs", () => {
  const policy = derivePromptSourcePolicy(
    "I need official docs pages for setting up MCP servers from Anthropic, OpenAI, and Cloudflare.",
  );
  const spec: DatasetSpec = {
    intent_summary: "Official MCP docs pages.",
    target_row_count: 3,
    row_grain: "one row per vendor",
    columns: [
      {
        name: "entity_name",
        type: "string",
        description: "Vendor name.",
        required: true,
      },
      {
        name: "docs_url",
        type: "string",
        description: "Official docs page URL.",
        required: true,
      },
    ],
    dedupe_keys: ["entity_name"],
    search_queries: [],
    extraction_hints: "",
  };

  assert.equal(
    recordMatchesPromptSourcePolicy(
      record("Anthropic", "https://modelcontextprotocol.io/docs/develop/build-server"),
      spec,
      policy,
    ),
    false,
  );
  assert.equal(
    recordMatchesPromptSourcePolicy(
      record(
        "Anthropic",
        "https://platform.claude.com/docs/en/agents-and-tools/remote-mcp-servers",
      ),
      spec,
      policy,
    ),
    true,
  );
  assert.equal(
    recordMatchesPromptSourcePolicy(
      record("OpenAI", "https://developers.openai.com/blog"),
      spec,
      policy,
    ),
    false,
  );
  assert.equal(
    recordMatchesPromptSourcePolicy(
      record("OpenAI", "https://developers.openai.com/api/docs/guides/tools-connectors-mcp"),
      spec,
      policy,
    ),
    true,
  );
});

function record(entityName: string, docsUrl: string): ExtractedRecord {
  return {
    row: {
      entity_name: entityName,
      docs_url: docsUrl,
    },
    evidence: [
      {
        field: "docs_url",
        url: docsUrl,
        quote: docsUrl,
      },
    ],
    source_urls: [docsUrl],
    extraction_confidence: 0.8,
  };
}
