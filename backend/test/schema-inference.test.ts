import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveInitialSearchQueryCap,
  resolvePopulateDataSpec,
} from "../src/pipeline/schema-inference.js";
import type { DatasetSchema } from "../src/pipeline/types.js";

function mockDataSpec(searchQueries: string[]): DatasetSchema {
  return {
    dataset_name: "earnings_releases",
    description: "Latest earnings releases.",
    primary_key: "entity_name",
    search_queries: searchQueries,
    columns: [
      {
        name: "entity_name",
        display_name: "Company",
        type: "string",
        is_primary_key: true,
        is_enumerable: true,
        description: "Company name.",
        nullable: false,
      },
    ],
  };
}

test("resolveInitialSearchQueryCap uses half of max search calls", () => {
  assert.equal(resolveInitialSearchQueryCap(20), 10);
  assert.equal(resolveInitialSearchQueryCap(3), 1);
});

test("resolvePopulateDataSpec uses data spec queries when count matches", async () => {
  const queries = Array.from({ length: 5 }, (_, index) => `seed query ${index + 1}`);
  const dataSpec = mockDataSpec(queries);

  const resolved = await resolvePopulateDataSpec({
    prompt: "Earnings for Apple, Microsoft, and Nvidia.",
    dataSpec,
    maxSearchCalls: 10,
  });

  assert.deepEqual(resolved.initialQueries, queries);
  assert.equal(resolved.dataSpec, dataSpec);
});

test("resolvePopulateDataSpec infers when search_queries count mismatches", async () => {
  const inferred = mockDataSpec(["inferred a", "inferred b"]);
  const resolved = await resolvePopulateDataSpec({
    prompt: "Earnings releases.",
    dataSpec: mockDataSpec(["only one"]),
    maxSearchCalls: 4,
    inferSchemaFn: async () => inferred,
  });

  assert.deepEqual(resolved.initialQueries, ["inferred a", "inferred b"]);
  assert.equal(resolved.dataSpec, inferred);
});
