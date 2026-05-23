import assert from "node:assert/strict";
import { test } from "node:test";

import { shardPrioritizedUrlsEvenly } from "../src/pipeline/populate-parallel.js";

test("shardPrioritizedUrlsEvenly spreads high and low priority across workers", () => {
  const urls = Array.from({ length: 50 }, (_, index) => `https://example.com/${index}`);
  const shards = shardPrioritizedUrlsEvenly(urls, 5);

  assert.equal(shards.length, 10);
  assert.equal(shards.reduce((sum, shard) => sum + shard.length, 0), 50);
  assert.equal(shards[0]![0], "https://example.com/0");
  assert.equal(shards[0]![1], "https://example.com/10");
  assert.equal(shards[1]![0], "https://example.com/1");
  assert.equal(shards[9]![4], "https://example.com/49");
});
