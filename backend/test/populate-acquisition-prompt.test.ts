import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatDataSpecBlock,
  formatUserPromptBlock,
  isLowTrustSourceUrl,
} from "../src/pipeline/populate-acquisition-prompt.js";

const context = {
  datasetId: "dataset-1",
  datasetName: "ny_ai_startup_careers",
  description: "AI startups in New York with careers pages and hiring signals.",
  columns: [
    { name: "entity_name", type: "text" as const, description: "Company name." },
    { name: "careers_page_url", type: "url" as const, description: "Careers page URL." },
  ],
};

test("formatUserPromptBlock leads with user description", () => {
  const block = formatUserPromptBlock(context);
  assert.match(block, /User prompt \(primary/);
  assert.match(block, /AI startups in New York/);
});

test("formatDataSpecBlock uses infer-schema column descriptions when provided", () => {
  const block = formatDataSpecBlock(context, {
    dataset_name: "ny_ai_startup_careers",
    description: "Careers dataset for NYC AI startups.",
    primary_key: "entity_name",
    search_queries: [
      "NYC AI startup careers site:greenhouse.io",
      "New York AI company jobs hiring",
    ],
    columns: [
      {
        name: "entity_name",
        display_name: "Company",
        type: "string",
        is_primary_key: true,
        is_enumerable: true,
        description: "Official company name.",
        nullable: false,
      },
      {
        name: "careers_page_url",
        display_name: "Careers URL",
        type: "url",
        is_primary_key: false,
        is_enumerable: false,
        description: "URL of the official careers or jobs page.",
        nullable: true,
      },
    ],
  });

  assert.match(block, /Initial search queries/);
  assert.match(block, /NYC AI startup careers/);
  assert.match(block, /Description: Official company name/);
  assert.match(block, /Description: URL of the official careers/);
  assert.match(block, /Primary key column: entity_name/);
  assert.doesNotMatch(block, /Retrieval strategy/);
  assert.doesNotMatch(block, /Source hint/);
});

test("isLowTrustSourceUrl flags major social hosts", () => {
  assert.equal(isLowTrustSourceUrl("https://www.instagram.com/p/abc/"), true);
  assert.equal(isLowTrustSourceUrl("https://x.com/user/status/1"), true);
  assert.equal(isLowTrustSourceUrl("https://anthropic.com/careers"), false);
});
