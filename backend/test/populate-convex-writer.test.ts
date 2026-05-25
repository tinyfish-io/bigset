import assert from "node:assert/strict";
import { test } from "node:test";

test("Convex populate row writer uses one atomic replace mutation", async () => {
  process.env.CONVEX_URL = process.env.CONVEX_URL ?? "https://example.convex.cloud";
  process.env.CONVEX_SELF_HOSTED_ADMIN_KEY =
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "test-admin-key";
  const { ConvexPopulateDatasetRowWriter } = await import(
    "../src/pipeline/populate-convex-writer.js"
  );
  const calls: Array<{ functionReference: unknown; args: unknown }> = [];
  const replaceByDataset = Symbol("replaceByDataset");
  const writer = new ConvexPopulateDatasetRowWriter({
    internalApi: {
      datasetRows: {
        replaceByDataset,
      },
    },
    convexClient: {
      async mutation(functionReference, args) {
        calls.push({ functionReference, args });
        return {
          clearedRowCount: 2,
          insertedRowCount: 1,
        };
      },
    },
  });

  const result = await writer.replaceRows({
    datasetId: "dataset-ai-posts",
    rows: [{
      cells: {
        entity_name: "OpenAI",
        source_url: "https://openai.com/news",
      },
      sourceUrls: ["https://openai.com/news"],
      evidence: [{
        columnName: "entity_name",
        sourceUrl: "https://openai.com/news",
        quote: "OpenAI",
      }],
      needsReview: true,
    }],
  });

  assert.deepEqual(result, {
    clearedRowCount: 2,
    insertedRowCount: 1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.functionReference, replaceByDataset);
  assert.deepEqual(calls[0]?.args, {
    datasetId: "dataset-ai-posts",
      rows: [{
        data: {
          entity_name: "OpenAI",
          source_url: "https://openai.com/news",
        },
        sources: ["https://openai.com/news"],
        evidence: [{
          columnName: "entity_name",
          sourceUrl: "https://openai.com/news",
          quote: "OpenAI",
        }],
      }],
    });
});
