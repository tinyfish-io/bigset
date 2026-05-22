import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergePair,
  mergeRecords,
} from "../BigSet_Data_Collection_Agent/src/merge/records.js";
import type {
  DatasetSpec,
  ExtractedRecord,
} from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

const docsSpec: DatasetSpec = {
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
      name: "docs_title",
      type: "string",
      description: "Docs page title.",
      required: true,
    },
    {
      name: "docs_url",
      type: "string",
      description: "Official docs page URL.",
      required: true,
    },
    {
      name: "summary",
      type: "string",
      description: "What the page covers.",
      required: true,
    },
  ],
  dedupe_keys: ["entity_name"],
  search_queries: ["MCP docs"],
  extraction_hints: "Prefer official docs pages.",
};

test("collection record merge does not attach evidence from conflicting duplicate rows", () => {
  const officialRecord = record({
    row: {
      entity_name: "Cloudflare",
      docs_title: "Connect to an MCP server",
      docs_url: "https://developers.cloudflare.com/agents/guides/connect-mcp-client/",
      summary: "Official docs for connecting an MCP client.",
    },
    evidence: [
      evidence(
        "summary",
        "https://developers.cloudflare.com/agents/guides/connect-mcp-client/",
        "Connect to an MCP server."
      ),
    ],
    sourceUrls: [
      "https://developers.cloudflare.com/agents/guides/connect-mcp-client/",
    ],
  });
  const blogRecord = record({
    row: {
      entity_name: "Cloudflare",
      docs_title: "Code Mode: the better way to use MCP",
      docs_url: "https://blog.cloudflare.com/code-mode/",
      summary: "Blog post about code mode.",
    },
    evidence: [
      evidence(
        "docs_title",
        "https://blog.cloudflare.com/code-mode/",
        "Code Mode: the better way to use MCP"
      ),
      evidence(
        "docs_url",
        "https://blog.cloudflare.com/code-mode/",
        "https://blog.cloudflare.com/code-mode/"
      ),
    ],
    sourceUrls: ["https://blog.cloudflare.com/code-mode/"],
  });

  const merged = mergePair(officialRecord, blogRecord, docsSpec);

  assert.equal(
    merged.row.docs_url,
    "https://developers.cloudflare.com/agents/guides/connect-mcp-client/"
  );
  assert.deepEqual(
    merged.evidence.map((item) => item.url),
    ["https://developers.cloudflare.com/agents/guides/connect-mcp-client/"]
  );
  assert.deepEqual(merged.source_urls, [
    "https://developers.cloudflare.com/agents/guides/connect-mcp-client/",
  ]);
});

test("collection record merge keeps incoming evidence when it fills a missing field", () => {
  const partialRecord = record({
    row: {
      entity_name: "OpenAI",
      docs_title: "MCP and Connectors",
      docs_url: null,
      summary: "OpenAI MCP docs.",
    },
    evidence: [
      evidence(
        "summary",
        "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
        "remote MCP servers and connectors"
      ),
    ],
    sourceUrls: [
      "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
    ],
  });
  const urlRecord = record({
    row: {
      entity_name: "OpenAI",
      docs_title: "MCP and Connectors",
      docs_url: "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
      summary: null,
    },
    evidence: [
      evidence(
        "docs_url",
        "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
        "https://developers.openai.com/api/docs/guides/tools-connectors-mcp"
      ),
    ],
    sourceUrls: [
      "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
    ],
  });

  const merged = mergePair(partialRecord, urlRecord, docsSpec);

  assert.equal(
    merged.row.docs_url,
    "https://developers.openai.com/api/docs/guides/tools-connectors-mcp"
  );
  assert.deepEqual(
    merged.evidence.map((item) => item.field),
    ["summary", "docs_url"]
  );
  assert.deepEqual(merged.source_urls, [
    "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
  ]);
});

test("collection record merge keeps same-value supplemental evidence", () => {
  const merged = mergeRecords(docsSpec, [
    record({
      row: {
        entity_name: "Anthropic",
        docs_title: "Model Context Protocol connector",
        docs_url: "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
        summary: "Connector docs.",
      },
      evidence: [
        evidence(
          "summary",
          "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
          "MCP connector"
        ),
      ],
      sourceUrls: [
        "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
      ],
    }),
    record({
      row: {
        entity_name: "Anthropic",
        docs_title: "Model Context Protocol connector",
        docs_url: "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
        summary: "Connector docs.",
      },
      evidence: [
        evidence(
          "docs_title",
          "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
          "Model Context Protocol connector"
        ),
      ],
      sourceUrls: [
        "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
      ],
    }),
  ]).records;

  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0]?.evidence.map((item) => item.field),
    ["summary", "docs_title"]
  );
});

test("collection record merge replaces weak docs URLs with stronger docs surfaces", () => {
  const merged = mergePair(
    record({
      row: {
        entity_name: "Cloudflare",
        docs_title: "Code Mode: the better way to use MCP",
        docs_url: "https://blog.cloudflare.com/code-mode/",
        summary: "Blog post about MCP code mode.",
      },
      evidence: [
        evidence(
          "docs_url",
          "https://blog.cloudflare.com/code-mode/",
          "https://blog.cloudflare.com/code-mode/"
        ),
      ],
      sourceUrls: ["https://blog.cloudflare.com/code-mode/"],
    }),
    record({
      row: {
        entity_name: "Cloudflare",
        docs_title: "Model Context Protocol",
        docs_url: "https://developers.cloudflare.com/agents/model-context-protocol/",
        summary: "Official docs for Cloudflare MCP servers.",
      },
      evidence: [
        evidence(
          "docs_title",
          "https://developers.cloudflare.com/agents/model-context-protocol/",
          "Model Context Protocol"
        ),
        evidence(
          "docs_url",
          "https://developers.cloudflare.com/agents/model-context-protocol/",
          "https://developers.cloudflare.com/agents/model-context-protocol/"
        ),
        evidence(
          "summary",
          "https://developers.cloudflare.com/agents/model-context-protocol/",
          "MCP servers"
        ),
      ],
      sourceUrls: [
        "https://developers.cloudflare.com/agents/model-context-protocol/",
      ],
    }),
    docsSpec,
  );

  assert.equal(
    merged.row.docs_url,
    "https://developers.cloudflare.com/agents/model-context-protocol/"
  );
  assert.equal(merged.row.docs_title, "Model Context Protocol");
  assert.equal(merged.row.summary, "Official docs for Cloudflare MCP servers.");
  assert.deepEqual(
    merged.evidence.map((item) => item.field),
    ["docs_title", "docs_url", "summary"]
  );
  assert.deepEqual(
    merged.evidence.map((item) => item.url),
    [
      "https://developers.cloudflare.com/agents/model-context-protocol/",
      "https://developers.cloudflare.com/agents/model-context-protocol/",
      "https://developers.cloudflare.com/agents/model-context-protocol/",
    ]
  );
  assert.deepEqual(merged.source_urls, [
    "https://developers.cloudflare.com/agents/model-context-protocol/",
  ]);
});

test("collection record merge drops docs URL evidence from unrelated source pages", () => {
  const merged = mergePair(
    record({
      row: {
        entity_name: "Cloudflare",
        docs_title: "Docs for agents",
        docs_url: null,
        summary: null,
      },
      evidence: [],
      sourceUrls: [],
    }),
    record({
      row: {
        entity_name: "Cloudflare",
        docs_title: "Model Context Protocol",
        docs_url: "https://developers.cloudflare.com/agents/model-context-protocol/",
        summary: "Official docs for Cloudflare MCP servers.",
      },
      evidence: [
        evidence(
          "docs_url",
          "https://developers.openai.com/api/docs",
          "https://developers.cloudflare.com/agents/model-context-protocol/"
        ),
        evidence(
          "summary",
          "https://developers.cloudflare.com/agents/model-context-protocol/",
          "MCP servers"
        ),
      ],
      sourceUrls: [
        "https://developers.openai.com/api/docs",
        "https://developers.cloudflare.com/agents/model-context-protocol/",
      ],
    }),
    docsSpec,
  );

  assert.equal(
    merged.row.docs_url,
    "https://developers.cloudflare.com/agents/model-context-protocol/"
  );
  assert.deepEqual(
    merged.evidence.map((item) => item.field),
    ["summary"]
  );
  assert.deepEqual(merged.source_urls, [
    "https://developers.cloudflare.com/agents/model-context-protocol/",
  ]);
});

test("collection record merge fixture reaches benchmark-equivalent domain coverage", () => {
  const merged = mergeRecords(docsSpec, [
    record({
      row: {
        entity_name: "OpenAI",
        docs_title: "MCP and Connectors",
        docs_url: "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
        summary: "OpenAI MCP docs.",
      },
      evidence: [
        evidence(
          "summary",
          "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
          "remote MCP servers and connectors"
        ),
      ],
      sourceUrls: [
        "https://developers.openai.com/api/docs/guides/tools-connectors-mcp",
      ],
    }),
    record({
      row: {
        entity_name: "Anthropic",
        docs_title: "Introduction to Model Context Protocol",
        docs_url: "https://anthropic.skilljar.com/introduction-to-model-context-protocol",
        summary: "Anthropic MCP course.",
      },
      evidence: [
        evidence(
          "summary",
          "https://anthropic.skilljar.com/introduction-to-model-context-protocol",
          "course provides comprehensive coverage"
        ),
      ],
      sourceUrls: [
        "https://anthropic.skilljar.com/introduction-to-model-context-protocol",
      ],
    }),
    record({
      row: {
        entity_name: "Anthropic",
        docs_title: "MCP connector",
        docs_url: "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
        summary: "Anthropic MCP connector docs.",
      },
      evidence: [
        evidence(
          "docs_url",
          "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
          "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector"
        ),
      ],
      sourceUrls: [
        "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
      ],
    }),
    record({
      row: {
        entity_name: "Cloudflare",
        docs_title: "Code Mode",
        docs_url: "https://blog.cloudflare.com/code-mode/",
        summary: "Cloudflare MCP blog post.",
      },
      evidence: [
        evidence(
          "summary",
          "https://blog.cloudflare.com/code-mode/",
          "Cloudflare Agents SDK"
        ),
      ],
      sourceUrls: ["https://blog.cloudflare.com/code-mode/"],
    }),
    record({
      row: {
        entity_name: "Cloudflare",
        docs_title: "Model Context Protocol",
        docs_url: "https://developers.cloudflare.com/agents/model-context-protocol/",
        summary: "Cloudflare MCP docs.",
      },
      evidence: [
        evidence(
          "docs_url",
          "https://developers.cloudflare.com/agents/model-context-protocol/",
          "https://developers.cloudflare.com/agents/model-context-protocol/"
        ),
      ],
      sourceUrls: [
        "https://developers.cloudflare.com/agents/model-context-protocol/",
      ],
    }),
  ]).records;

  assert.equal(merged.length, 3);
  assert.equal(
    merged.find((item) => item.row.entity_name === "Anthropic")?.row.docs_url,
    "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector"
  );
  assert.equal(
    merged.find((item) => item.row.entity_name === "Cloudflare")?.row.docs_url,
    "https://developers.cloudflare.com/agents/model-context-protocol/"
  );
  assert.equal(
    domainCoverage(merged, {
      OpenAI: ["developers.openai.com", "platform.openai.com", "openai.com"],
      Anthropic: ["docs.anthropic.com"],
      Cloudflare: ["developers.cloudflare.com"],
    }),
    1,
  );
});

function evidence(field: string, url: string, quote: string) {
  return { field, url, quote };
}

function record(input: {
  row: ExtractedRecord["row"];
  evidence: ExtractedRecord["evidence"];
  sourceUrls: string[];
}): ExtractedRecord {
  return {
    row: input.row,
    evidence: input.evidence,
    source_urls: input.sourceUrls,
    extraction_confidence: 0.9,
  };
}

function domainCoverage(
  records: ExtractedRecord[],
  allowedDomainsByEntity: Record<string, string[]>,
): number {
  const matched = records.filter((record) => {
    const entity = String(record.row.entity_name ?? "");
    const allowedDomains = allowedDomainsByEntity[entity] ?? [];
    return record.source_urls.some((url) =>
      allowedDomains.some((domain) => hostname(url).endsWith(domain)),
    );
  });
  return matched.length / records.length;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
