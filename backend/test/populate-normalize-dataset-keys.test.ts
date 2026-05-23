import assert from "node:assert/strict";
import { test } from "node:test";

import type { DatasetContext } from "../src/pipeline/populate.js";
import type { DatasetSchema } from "../src/pipeline/types.js";
import {
  buildPopulateColumnKeyAliases,
  normalizePopulateRowCellsForDataset,
} from "../src/pipeline/populate-normalize-dataset-keys.js";

const context: DatasetContext = {
  datasetId: "ds_test",
  datasetName: "AI Companies",
  description: "Top AI companies",
  columns: [
    { name: "Company Name", type: "text", description: "Legal or brand name" },
    { name: "Official Website", type: "url", description: "Homepage" },
    { name: "Description", type: "text", description: "What they do" },
    { name: "Source URL", type: "url", description: "Evidence URL" },
  ],
};

const dataSpec: DatasetSchema = {
  dataset_name: "ai_companies",
  description: "One row per AI company",
  primary_key: "company_name",
  search_queries: ["top AI companies 2025"],
  columns: [
    {
      name: "company_name",
      display_name: "Company Name",
      type: "string",
      is_primary_key: true,
      is_enumerable: true,
      description: "Legal or brand name",
      nullable: false,
    },
    {
      name: "official_website",
      display_name: "Official Website",
      type: "url",
      is_primary_key: false,
      is_enumerable: false,
      description: "Homepage",
      nullable: true,
    },
    {
      name: "description",
      display_name: "Description",
      type: "string",
      is_primary_key: false,
      is_enumerable: false,
      description: "What they do",
      nullable: true,
    },
    {
      name: "source_url",
      display_name: "Source URL",
      type: "url",
      is_primary_key: false,
      is_enumerable: false,
      description: "Evidence URL",
      nullable: true,
    },
  ],
};

test("buildPopulateColumnKeyAliases maps snake_case extraction keys to dataset column names", () => {
  const aliases = buildPopulateColumnKeyAliases(dataSpec, context);

  assert.equal(aliases.get("company_name"), "Company Name");
  assert.equal(aliases.get("official_website"), "Official Website");
  assert.equal(aliases.get("source_url"), "Source URL");
  assert.equal(aliases.get("Company Name"), "Company Name");
});

test("normalizePopulateRowCellsForDataset rewrites row.cells before Convex write", () => {
  const aliases = buildPopulateColumnKeyAliases(dataSpec, context);
  const normalized = normalizePopulateRowCellsForDataset(
    {
      company_name: "OpenAI",
      official_website: "https://openai.com",
      description: "AI research lab",
      source_url: "https://openai.com/about",
    },
    aliases
  );

  assert.deepEqual(normalized, {
    "Company Name": "OpenAI",
    "Official Website": "https://openai.com",
    Description: "AI research lab",
    "Source URL": "https://openai.com/about",
  });
});

test("normalizePopulateRowCellsForDataset keeps already-correct keys", () => {
  const aliases = buildPopulateColumnKeyAliases(dataSpec, context);
  const normalized = normalizePopulateRowCellsForDataset(
    {
      "Company Name": "Anthropic",
      "Official Website": "https://anthropic.com",
    },
    aliases
  );

  assert.deepEqual(normalized, {
    "Company Name": "Anthropic",
    "Official Website": "https://anthropic.com",
  });
});
