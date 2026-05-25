import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvexPopulateDatasetOwnerLoader } from "../src/pipeline/populate-dataset-owner-loader.js";

test("Convex dataset owner loader uses trusted system populate query", async () => {
  const getForSystemPopulate = Symbol("getForSystemPopulate");
  const calls: Array<{ functionReference: unknown; args: unknown }> = [];
  const loader = new ConvexPopulateDatasetOwnerLoader({
    internalApi: {
      datasets: {
        getForSystemPopulate,
      },
    },
    convexClient: {
      async query(functionReference, args) {
        calls.push({ functionReference, args });
        return { ownerId: "user-1" };
      },
    },
  });

  const dataset = await loader.loadDataset("dataset-ai-posts");

  assert.deepEqual(calls, [{
    functionReference: getForSystemPopulate,
    args: { id: "dataset-ai-posts" },
  }]);
  assert.deepEqual(dataset, { ownerId: "user-1" });
});

test("Convex dataset owner loader returns null for missing dataset", async () => {
  const loader = new ConvexPopulateDatasetOwnerLoader({
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

  assert.equal(await loader.loadDataset("missing-dataset"), null);
});

test("Convex dataset owner loader rejects malformed dataset owner", async () => {
  const loader = new ConvexPopulateDatasetOwnerLoader({
    internalApi: {
      datasets: {
        getForSystemPopulate: Symbol("getForSystemPopulate"),
      },
    },
    convexClient: {
      async query() {
        return { ownerId: "" };
      },
    },
  });

  await assert.rejects(
    loader.loadDataset("dataset-ai-posts"),
    /Dataset dataset-ai-posts is missing ownerId/
  );
});
