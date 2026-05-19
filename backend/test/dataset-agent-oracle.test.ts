import assert from "node:assert/strict";
import { test } from "node:test";

import { AiSdkDatasetAgentRuntime } from "../src/dataset-agent/ai-sdk-runtime.js";
import { DeterministicDatasetAgentRuntime } from "../src/dataset-agent/deterministic-runtime.js";
import { createDatasetAgentRuntime } from "../src/dataset-agent/index.js";
import type { DatasetAgentToolProvider } from "../src/dataset-agent/types.js";

const runInput = {
  prompt:
    "Find latest blog posts from OpenAI and Anthropic with title, date, and URL.",
  promptId: "oracle-latest-posts",
  promptQuality: "good",
  requiredColumns: [
    "entity_name",
    "latest_post_title",
    "latest_post_date",
    "source_url",
  ],
};

test("deterministic runtime satisfies benchmark contract without secrets", async () => {
  const runtime = new DeterministicDatasetAgentRuntime();
  const result = await runtime.runDatasetBuild(runInput);

  assert.equal(result.rows.length, 1);
  assert.equal(result.validationIssues.length, 0);
  assert.equal(result.rows[0]?.sourceUrls.length, 1);
  assert.equal(result.rows[0]?.evidence.length, 1);
  assert.equal(result.metrics.searchCalls, 1);
  assert.equal(result.metrics.fetchCalls, 1);
  assert.equal(result.metrics.agentRuns, 1);
  assert.ok(result.usage.totalTokens > 0);
});

test("runtime factory defaults to deterministic when explicitly requested", async () => {
  const runtime = createDatasetAgentRuntime({ runtime: "deterministic" });
  const result = await runtime.runDatasetBuild(runInput);

  assert.equal(result.rows[0]?.cells.entity_name, runInput.prompt);
});

test("AI SDK runtime normalizes output and accumulates usage from step callbacks", async () => {
  const calls: Array<{ prompt: string }> = [];
  const runtime = new AiSdkDatasetAgentRuntime({
    model: "test/model",
    toolProvider: fakeToolProvider(),
    maxSteps: 4,
    createAgent: ({ onStepFinish }) => ({
      async generate(input) {
        calls.push(input);
        onStepFinish({
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });
        return {
          output: {
            rows: [
              {
                cells: {
                  entity_name: "OpenAI",
                  latest_post_title: "Release notes",
                  latest_post_date: "2026-05-19",
                  source_url: "https://openai.com/news",
                },
                sourceUrls: ["https://openai.com/news"],
                evidence: [
                  {
                    columnName: "latest_post_title",
                    sourceUrl: "https://openai.com/news",
                    quote: "Release notes",
                  },
                ],
              },
            ],
            validationIssues: [],
          },
          usage: {
            promptTokens: 20,
            completionTokens: 7,
            totalTokens: 27,
          },
          steps: [{}, {}],
        };
      },
    }),
  });

  const result = await runtime.runDatasetBuild(runInput);

  assert.equal(calls.length, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.validationIssues.length, 0);
  assert.deepEqual(result.usage, {
    promptTokens: 30,
    completionTokens: 12,
    totalTokens: 42,
  });
  assert.equal(result.metrics.agentRuns, 1);
  assert.equal(result.metrics.agentSteps, 2);
});

test("AI SDK runtime reports invalid source-free rows as validation issues", async () => {
  const runtime = new AiSdkDatasetAgentRuntime({
    model: "test/model",
    toolProvider: fakeToolProvider(),
    createAgent: () => ({
      async generate() {
        return {
          output: {
            rows: [{ cells: { entity_name: "No source" } }],
            validationIssues: [],
          },
          usage: {},
          steps: [],
        };
      },
    }),
  });

  const result = await runtime.runDatasetBuild(runInput);

  assert.match(result.validationIssues.join("\n"), /no source URL/i);
  assert.match(result.validationIssues.join("\n"), /no evidence quote/i);
  assert.match(result.validationIssues.join("\n"), /latest_post_title/i);
  assert.equal(result.metrics.agentRuns, 2);
});

test("AI SDK runtime self-heals once when the first output fails validation", async () => {
  let generateCount = 0;
  const runtime = new AiSdkDatasetAgentRuntime({
    model: "test/model",
    toolProvider: fakeToolProvider(),
    createAgent: () => ({
      async generate() {
        generateCount += 1;
        if (generateCount === 1) {
          return {
            output: {
              rows: [{ cells: { entity_name: "No source" } }],
              validationIssues: [],
            },
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            steps: [{}],
          };
        }

        return {
          output: {
            rows: [
              {
                cells: {
                  entity_name: "OpenAI",
                  latest_post_title: "Release notes",
                  latest_post_date: "2026-05-19",
                  source_url: "https://openai.com/news",
                },
                sourceUrls: ["https://openai.com/news"],
                evidence: [
                  {
                    columnName: "latest_post_title",
                    sourceUrl: "https://openai.com/news",
                    quote: "Release notes",
                  },
                ],
              },
            ],
            validationIssues: [],
          },
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
          steps: [{}, {}],
        };
      },
    }),
  });

  const result = await runtime.runDatasetBuild(runInput);

  assert.equal(generateCount, 2);
  assert.equal(result.validationIssues.length, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.metrics.agentRuns, 2);
  assert.equal(result.metrics.agentSteps, 2);
  assert.deepEqual(result.usage, {
    promptTokens: 3,
    completionTokens: 3,
    totalTokens: 6,
  });
});

test("AI SDK runtime keeps repair telemetry when repair is worse", async () => {
  let generateCount = 0;
  const runtime = new AiSdkDatasetAgentRuntime({
    model: "test/model",
    toolProvider: fakeToolProvider(),
    createAgent: () => ({
      async generate() {
        generateCount += 1;
        if (generateCount === 1) {
          return {
            output: {
              rows: [
                {
                  cells: { entity_name: "OpenAI" },
                  sourceUrls: ["https://openai.com/news"],
                  evidence: ["OpenAI news"],
                },
              ],
              validationIssues: [],
            },
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
            steps: [{}],
          };
        }

        return {
          output: {
            rows: [{ cells: {} }],
            validationIssues: ["Repair made output worse."],
          },
          usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
          steps: [{}, {}],
        };
      },
    }),
  });

  const result = await runtime.runDatasetBuild(runInput);

  assert.equal(generateCount, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
  assert.equal(result.metrics.agentRuns, 2);
  assert.equal(result.metrics.agentSteps, 2);
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 6,
    totalTokens: 16,
  });
});

function fakeToolProvider(): DatasetAgentToolProvider {
  return {
    async search() {
      return [
        {
          title: "OpenAI News",
          url: "https://openai.com/news",
          snippet: "Latest news",
        },
      ];
    },
    async fetch() {
      return [
        {
          url: "https://openai.com/news",
          title: "OpenAI News",
          text: "Release notes",
        },
      ];
    },
    async browser() {
      return {
        url: "https://openai.com/news",
        status: "completed",
        payload: {},
        stepCount: 3,
      };
    },
  };
}
