import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvexPopulateDatasetContextLoader } from "../src/pipeline/populate-dataset-context-loader.js";

test("Convex dataset context loader maps system dataset to populate context", async () => {
  const getForSystemPopulate = Symbol("getForSystemPopulate");
  const calls: Array<{ functionReference: unknown; args: unknown }> = [];
  const loader = new ConvexPopulateDatasetContextLoader({
    internalApi: {
      datasets: {
        getForSystemPopulate,
      },
    },
    convexClient: {
      async query(functionReference, args) {
        calls.push({ functionReference, args });
        return {
          name: "AI posts",
          description: "Find latest blog posts from OpenAI.",
          columns: [{
            name: "entity_name",
            type: "text",
            description: "Company name.",
          }],
        };
      },
    },
  });

  const context = await loader.loadContext("dataset-ai-posts");

  assert.deepEqual(calls, [{
    functionReference: getForSystemPopulate,
    args: { id: "dataset-ai-posts" },
  }]);
  assert.deepEqual(context, {
    datasetId: "dataset-ai-posts",
    datasetName: "AI posts",
    description: "Find latest blog posts from OpenAI.",
    columns: [{
      name: "entity_name",
      type: "text",
      description: "Company name.",
    }],
  });
});

test("Convex dataset context loader rejects missing dataset", async () => {
  const loader = new ConvexPopulateDatasetContextLoader({
    internalApi: {
      datasets: {
        getForSystemPopulate: Symbol("getForSystemPopulate"),
      },
    },
    convexClient: {
      async query() {
        return null;
      },
    },
  });

  await assert.rejects(
    loader.loadContext("missing-dataset"),
    /Dataset missing-dataset not found/
  );
});
