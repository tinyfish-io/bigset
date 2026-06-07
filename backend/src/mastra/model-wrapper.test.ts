import test from "node:test";
import assert from "node:assert";
import { wrapModelWithTokenLimit } from "./model-wrapper.js";

test("wrapModelWithTokenLimit - doGenerate intercepts and caps maxTokens", async () => {
  let receivedOptions: any = null;

  const mockModel: any = {
    provider: "test-provider",
    modelId: "test-model",
    doGenerate: async (options: any) => {
      receivedOptions = options;
      return { text: "mock response" };
    },
    doStream: async (options: any) => {
      receivedOptions = options;
      return { stream: "mock stream" };
    },
  };

  const wrapped = wrapModelWithTokenLimit(mockModel, 4096);

  // 1. Default maxTokens when not provided
  await wrapped.doGenerate({ prompt: "hello" });
  assert.strictEqual(receivedOptions.maxTokens, 4096);

  // 2. Cap maxTokens when it exceeds the limit
  await wrapped.doGenerate({ prompt: "hello", maxTokens: 99999 });
  assert.strictEqual(receivedOptions.maxTokens, 4096);

  // 3. Keep maxTokens when it is below the limit
  await wrapped.doGenerate({ prompt: "hello", maxTokens: 1000 });
  assert.strictEqual(receivedOptions.maxTokens, 1000);

  // 4. Test doStream default
  await wrapped.doStream({ prompt: "hello" });
  assert.strictEqual(receivedOptions.maxTokens, 4096);

  // 5. Test doStream cap
  await wrapped.doStream({ prompt: "hello", maxTokens: 99999 });
  assert.strictEqual(receivedOptions.maxTokens, 4096);

  // 6. Test doStream keep below limit
  await wrapped.doStream({ prompt: "hello", maxTokens: 1000 });
  assert.strictEqual(receivedOptions.maxTokens, 1000);
});

test("wrapModelWithTokenLimit - forwards properties and binds functions", () => {
  const mockModel: any = {
    provider: "test-provider",
    modelId: "test-model",
    someFunc() {
      return this.provider;
    },
  };

  const wrapped = wrapModelWithTokenLimit(mockModel, 4096);

  assert.strictEqual(wrapped.provider, "test-provider");
  assert.strictEqual(wrapped.modelId, "test-model");
  assert.strictEqual(wrapped.someFunc(), "test-provider");
});
