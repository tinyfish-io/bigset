import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyLlmUsage,
  getCurrentLlmUsage,
  recordLanguageModelUsage,
  runWithLlmUsageScope,
  toPopulateRuntimeUsage,
} from "../src/pipeline/llm-usage.js";

test("runWithLlmUsageScope accumulates token usage across calls", async () => {
  const { usage } = await runWithLlmUsageScope(async () => {
    recordLanguageModelUsage({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
    });
    recordLanguageModelUsage({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
    });
    return getCurrentLlmUsage();
  });

  assert.equal(usage.promptTokens, 150);
  assert.equal(usage.completionTokens, 50);
  assert.equal(usage.totalTokens, 200);
  assert.equal(usage.callCount, 2);
  assert.deepEqual(toPopulateRuntimeUsage(usage), {
    promptTokens: 150,
    completionTokens: 50,
    totalTokens: 200,
  });
});

test("recordLanguageModelUsage ignores calls outside an active scope", () => {
  recordLanguageModelUsage({
    inputTokens: 999,
    outputTokens: 999,
    totalTokens: 1998,
  });
  assert.deepEqual(getCurrentLlmUsage(), emptyLlmUsage());
});
