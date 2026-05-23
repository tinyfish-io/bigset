import assert from "node:assert/strict";
import { test } from "node:test";

import { finalizeExtractedRecord } from "../BigSet_Data_Collection_Agent/src/agents/extract.js";
import type { DatasetSpec } from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

const docsSpec: DatasetSpec = {
  intent_summary: "Official docs pages.",
  target_row_count: 1,
  row_grain: "one row per docs page",
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
      description: "Official docs URL.",
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
  search_queries: ["Cloudflare MCP docs"],
  extraction_hints: "Prefer official docs pages.",
};

test("collection extraction adds URL cell evidence when model omits evidence", () => {
  const record = finalizeExtractedRecord(
    {
      row: {
        entity_name: "Cloudflare",
        docs_url: "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
        summary: "Remote MCP server docs.",
      },
      evidence: [],
      extraction_confidence: 0.8,
    },
    "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
    docsSpec,
  );

  assert.deepEqual(record.evidence, [
    {
      field: "docs_url",
      url: "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
      quote: "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
    },
  ]);
  assert.deepEqual(record.source_urls, [
    "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
  ]);
});

test("collection extraction treats official website cells as source URLs", () => {
  const spec: DatasetSpec = {
    intent_summary: "Official company websites.",
    target_row_count: 1,
    row_grain: "one row per company",
    columns: [
      {
        name: "entity_name",
        type: "string",
        description: "Company name.",
        required: true,
      },
      {
        name: "official_website",
        type: "string",
        description: "Official website URL.",
        required: true,
      },
      {
        name: "description",
        type: "string",
        description: "Company description.",
        required: true,
      },
      {
        name: "source_url",
        type: "string",
        description: "Where the row facts were found.",
        required: true,
      },
    ],
    dedupe_keys: ["entity_name"],
    search_queries: ["Vietnam fintech official websites"],
    extraction_hints: "Prefer official company websites.",
  };

  const record = finalizeExtractedRecord(
    {
      row: {
        entity_name: "MoMo",
        official_website: "https://momo.vn",
        description: "Vietnamese fintech wallet.",
        source_url: "https://www.startupblink.com/top-startups/vietnam",
      },
      evidence: [
        {
          field: "description",
          quote: "MoMo is a FinTech startup.",
        },
      ],
      extraction_confidence: 0.8,
    },
    "https://www.startupblink.com/top-startups/vietnam",
    spec,
  );

  assert.deepEqual(record.source_urls, [
    "https://www.startupblink.com/top-startups/vietnam",
    "https://momo.vn",
  ]);
  assert.ok(
    record.evidence.some((item) =>
      item.field === "official_website" &&
      item.url === "https://momo.vn" &&
      item.quote === "https://momo.vn"
    ),
  );
});
