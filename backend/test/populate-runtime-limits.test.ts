import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePopulateRuntimeLimits } from "../src/pipeline/populate-runtime-limits.js";

test("resolvePopulateRuntimeLimits uses POPULATE_MAX_FETCH_CALLS without search scaling", () => {
  const limits = resolvePopulateRuntimeLimits({
    maxRows: 5,
    maxSearchCalls: 4,
    maxFetchCalls: 100,
    env: {},
  });

  assert.equal(limits.maxRows, 5);
  assert.equal(limits.maxSearchCalls, 4);
  assert.equal(limits.maxFetchCalls, 100);
});

test("resolvePopulateRuntimeLimits reads env overrides", () => {
  const limits = resolvePopulateRuntimeLimits({
    env: {
      POPULATE_MAX_ROWS: "3",
      POPULATE_MAX_SEARCH_CALLS: "2",
      POPULATE_MAX_FETCH_CALLS: "5",
    },
  });

  assert.deepEqual(limits, {
    maxRows: 3,
    maxSearchCalls: 2,
    maxFetchCalls: 5,
  });
});

test("resolvePopulateRuntimeLimits defaults maxFetchCalls to 50", () => {
  const limits = resolvePopulateRuntimeLimits({ env: {} });
  assert.equal(limits.maxFetchCalls, 50);
});
