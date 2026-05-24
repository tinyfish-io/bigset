import assert from "node:assert/strict";
import { test } from "node:test";

import { runCollectionPopulatePipeline } from "../src/pipeline/collection-agent-runner.js";
import { playwrightCandidateReadinessForRun } from "../src/pipeline/populate-playwright-readiness.js";

test("collection agent runner maps vendored pipeline output into populate runtime result", async () => {
  const previousEnv = snapshotEnv([
    "AGENT_POLL_TIMEOUT_MS",
    "COLLECTION_AGENT_ENABLE_AGENT",
    "COLLECTION_AGENT_PIPELINE_MODULE",
    "COLLECTION_AGENT_POLL_TIMEOUT_MS",
  ]);
  delete process.env.AGENT_POLL_TIMEOUT_MS;
  delete process.env.COLLECTION_AGENT_ENABLE_AGENT;
  delete process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_PIPELINE_MODULE = fakeCollectionPipelineModuleUrl({
    expectedCalls: [{ agentEnabled: false }],
  });
  try {
    const result = await runCollectionPopulatePipeline(collectionPipelineInput());

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
    assert.equal(result.rows[0]?.cells.evidence_quote, "technical operator");
    assert.deepEqual(result.rows[0]?.sourceUrls, ["https://openai.com/news"]);
    assert.equal(result.rows[0]?.evidence[0]?.columnName, "entity_name");
    assert.equal(result.rows[0]?.needsReview, true);
    assert.deepEqual(result.validationIssues, []);
    assert.deepEqual(result.usage, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    assert.equal(result.metrics.searchCalls, 2);
    assert.equal(result.metrics.fetchCalls, 3);
    assert.equal(result.metrics.browserCalls, 3);
    assert.equal(result.metrics.agentRuns, 3);
    assert.equal(result.metrics.agentSteps, 3);
    assert.equal(result.debug?.selectedRowSource, "collection_pipeline");
    assert.equal(result.debug?.processTrace.runtime, "collection");
    assert.deepEqual(result.debug?.processTrace.searchQueries, [
      "OpenAI latest AI blog posts",
      "OpenAI release notes",
    ]);
    assert.deepEqual(result.debug?.processTrace.fetchedUrls, [
      "https://openai.com/news",
      "https://openai.com/research",
    ]);
    assert.equal(
      result.debug?.processTrace.sourceArtifacts.some((artifact) =>
        artifact.url === "https://openai.com/news" &&
        artifact.status === "succeeded"
      ),
      true
    );
    assert.equal(
      result.debug?.processTrace.steps.some((step) => step.kind === "browser"),
      false
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("collection agent runner maps explicit browser action reports into process trace", async () => {
  const previousEnv = snapshotEnv([
    "AGENT_POLL_TIMEOUT_MS",
    "COLLECTION_AGENT_ENABLE_AGENT",
    "COLLECTION_AGENT_PIPELINE_MODULE",
    "COLLECTION_AGENT_POLL_TIMEOUT_MS",
  ]);
  delete process.env.AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_ENABLE_AGENT = "true";
  delete process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_PIPELINE_MODULE = fakeCollectionPipelineModuleUrl({
    expectedCalls: [{ agentEnabled: true, pollTimeoutMs: 1_200_000 }],
    browserActions: [
      {
        action: "hover",
        url: "https://openai.com/news",
        status: "succeeded",
        phase: "initial-browser",
        label: "browser-open-news",
      },
    ],
    agentBrowserActions: [
      {
        action: "click",
        url: "https://openai.com/news",
        selector: "a[href*='/news/']",
        target_text: "Release notes",
        value_description: "not captured",
        status: "succeeded",
      },
    ],
  });
  try {
    const result = await runCollectionPopulatePipeline(collectionPipelineInput());
    const browserSteps = result.debug?.processTrace.steps.filter(
      (step) => step.kind === "browser"
    ) ?? [];

    assert.equal(browserSteps.length, 2);
    assert.equal(browserSteps[0]?.browserAction?.action, "unknown");
    assert.equal(browserSteps[0]?.label, "browser-open-news");
    assert.deepEqual(browserSteps[0]?.input, {
      url: "https://openai.com/news",
      selector: undefined,
      targetText: undefined,
      phase: "initial-browser",
    });
    assert.equal(browserSteps[0]?.error, undefined);
    assert.equal(browserSteps[1]?.browserAction?.action, "click");
    assert.equal(browserSteps[1]?.browserAction?.selector, "a[href*='/news/']");
    assert.equal(browserSteps[1]?.browserAction?.targetText, "Release notes");
    assert.equal(browserSteps[1]?.browserAction?.valueDescription, "not captured");
    assert.equal(browserSteps[1]?.status, "succeeded");
    assert.deepEqual(
      playwrightCandidateReadinessForRun({ result }),
      {
        status: "ready",
        reasons: [],
        browserStepCount: 2,
        sourceUrlCount: 2,
      }
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("collection agent runner surfaces Agent provenance when actions are missing", async () => {
  const previousEnv = snapshotEnv([
    "AGENT_POLL_TIMEOUT_MS",
    "COLLECTION_AGENT_ENABLE_AGENT",
    "COLLECTION_AGENT_PIPELINE_MODULE",
    "COLLECTION_AGENT_POLL_TIMEOUT_MS",
  ]);
  delete process.env.AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_ENABLE_AGENT = "true";
  delete process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_PIPELINE_MODULE = fakeCollectionPipelineModuleUrl({
    expectedCalls: [{ agentEnabled: true, pollTimeoutMs: 1_200_000 }],
    agentReportedStepCount: 4,
    agentRunsWithStreamingUrl: 1,
    agentRunsWithExplicitBrowserActions: 0,
  });
  try {
    const result = await runCollectionPopulatePipeline(collectionPipelineInput());

    assert.equal(result.metrics.agentSteps, 4);
    assert.equal(
      result.debug?.processTrace.notes.some((note) =>
        /reported 4 step\(s\), but emitted no explicit browser actions/i.test(note)
      ),
      true
    );
    assert.equal(
      playwrightCandidateReadinessForRun({ result }).status,
      "not_ready"
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("collection agent runner requires explicit Agent opt-in and caps poll timeout per warm process call", async () => {
  const previousEnv = snapshotEnv([
    "AGENT_POLL_TIMEOUT_MS",
    "COLLECTION_AGENT_ENABLE_AGENT",
    "COLLECTION_AGENT_PIPELINE_MODULE",
    "COLLECTION_AGENT_POLL_TIMEOUT_MS",
  ]);
  delete process.env.AGENT_POLL_TIMEOUT_MS;
  delete process.env.COLLECTION_AGENT_ENABLE_AGENT;
  delete process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_PIPELINE_MODULE = fakeCollectionPipelineModuleUrl({
    expectedModuleLoadPollTimeoutMs: null,
    expectedCalls: [
      { agentEnabled: false },
      { agentEnabled: true, pollTimeoutMs: 12345 },
      { agentEnabled: true, pollTimeoutMs: 23456 },
    ],
  });

  try {
    assert.equal(
      (await runCollectionPopulatePipeline(collectionPipelineInput())).rows.length,
      1
    );

    process.env.COLLECTION_AGENT_ENABLE_AGENT = "true";
    process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS = "12345";
    assert.equal(
      (await runCollectionPopulatePipeline(collectionPipelineInput())).rows.length,
      1
    );

    process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS = "23456";
    assert.equal(
      (await runCollectionPopulatePipeline(collectionPipelineInput())).rows.length,
      1
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("collection agent runner surfaces Agent-required capability diagnostics from source outcomes", async () => {
  const previousEnv = snapshotEnv([
    "AGENT_POLL_TIMEOUT_MS",
    "COLLECTION_AGENT_ENABLE_AGENT",
    "COLLECTION_AGENT_PIPELINE_MODULE",
    "COLLECTION_AGENT_POLL_TIMEOUT_MS",
  ]);
  delete process.env.AGENT_POLL_TIMEOUT_MS;
  delete process.env.COLLECTION_AGENT_ENABLE_AGENT;
  delete process.env.COLLECTION_AGENT_POLL_TIMEOUT_MS;
  process.env.COLLECTION_AGENT_PIPELINE_MODULE = fakeCollectionPipelineModuleUrl({
    expectedCalls: [{ agentEnabled: false }],
    sources: {
      outcomes: [
        {
          outcome: "agent_deferred",
          triage_status: "requires_navigation",
        },
        {
          outcome: "no_records",
          triage_status: "requires_form_submission",
        },
        {
          outcome: "success",
          triage_status: "requires_detail_page_followup",
        },
      ],
    },
  });

  try {
    const result = await runCollectionPopulatePipeline(collectionPipelineInput());
    const diagnostic = result.validationIssues.join("\n");

    assert.equal(result.rows.length, 1);
    assert.match(diagnostic, /Capability diagnostic: TinyFish Agent disabled/);
    assert.match(diagnostic, /2 page\(s\)/);
    assert.match(diagnostic, /requires_navigation=1/);
    assert.match(diagnostic, /requires_form_submission=1/);
    assert.doesNotMatch(
      diagnostic,
      /failed|missing|no rows|not found|invented|invalid/i
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

function collectionPipelineInput() {
  return {
    datasetId: "dataset-ai-posts",
    datasetName: "AI posts",
    description: "Find latest AI blog posts.",
    columns: [
      { name: "entity_name", type: "text" as const },
      { name: "source_url", type: "url" as const },
      { name: "evidence_quote", type: "text" as const },
    ],
    requiredColumns: ["entity_name", "source_url", "evidence_quote"],
    prompt: [
      "Dataset: AI posts",
      "Task: Find latest AI blog posts.",
      "",
      "Durable recipe instructions:",
      "Prefer official source pages.",
    ].join("\n"),
    recipeInstructions: "Prefer official source pages.",
    targetRows: 3,
    promptId: "latest-ai-blog-posts",
    promptQuality: "easy",
    persona: "technical operator",
    expectedStress: "Latest dated source pages.",
  };
}

function fakeCollectionPipelineModuleUrl(input: {
  expectedModuleLoadPollTimeoutMs?: string | null;
  expectedCalls: Array<{
    agentEnabled: boolean;
    pollTimeoutMs?: number;
  }>;
  sources?: unknown;
  browserActions?: unknown;
  agentBrowserActions?: unknown;
  agentReportedStepCount?: number;
  agentRunsWithStreamingUrl?: number;
  agentRunsWithExplicitBrowserActions?: number;
}): string {
  const source = `
    const moduleLoadPollTimeoutMs = process.env.AGENT_POLL_TIMEOUT_MS ?? null;
    const expectedModuleLoadPollTimeoutMs = ${JSON.stringify(input.expectedModuleLoadPollTimeoutMs ?? null)};
    const expectedCalls = ${JSON.stringify(input.expectedCalls)};
    let callIndex = 0;

    export async function runPipeline(options) {
      if (moduleLoadPollTimeoutMs !== expectedModuleLoadPollTimeoutMs) {
        throw new Error("unexpected module-load poll timeout");
      }
      const expected = expectedCalls[callIndex++];
      if (!expected) {
        throw new Error("unexpected extra pipeline call");
      }
      if (options.enableTinyfishAgent !== expected.agentEnabled) {
        throw new Error("unexpected TinyFish Agent setting");
      }
      if ((options.agentPollTimeoutMs ?? null) !== (expected.pollTimeoutMs ?? null)) {
        throw new Error("bounded agent poll timeout missing");
      }
      if (!options.prompt.includes("Durable recipe instructions")) {
        throw new Error("recipe instructions missing from prompt");
      }
      if (!options.memoryDir || !options.memoryDir.includes("memory")) {
        throw new Error("isolated memory dir missing");
      }
      if (options.benchmark?.promptId !== "latest-ai-blog-posts") {
        throw new Error("prompt id missing from benchmark context");
      }
      if (options.benchmark?.persona !== "technical operator") {
        throw new Error("persona missing from benchmark context");
      }
      if (options.benchmark?.requiredColumns?.join(",") !== "entity_name,source_url,evidence_quote") {
        throw new Error("required columns missing from benchmark context");
      }
      return {
        runId: "fake-run-1",
        paths: {
          root: "/tmp/fake-run-1",
          reportPath: "/tmp/fake-run-1/run_report.json",
        },
        report: {
          errors: [],
          dataset_spec: {
            columns: [{ name: "entity_name" }],
            dedupe_keys: ["entity_name"],
          },
          stats: {
            search_queries_executed: 2,
            pages_fetched: 3,
            triage: {
              agent_dispatched: 1,
              agent_succeeded: 1,
              agent_failed: 0,
              agent_reported_step_count: ${JSON.stringify(input.agentReportedStepCount)},
              agent_runs_with_streaming_url: ${JSON.stringify(input.agentRunsWithStreamingUrl)},
              agent_runs_with_explicit_browser_actions: ${JSON.stringify(input.agentRunsWithExplicitBrowserActions)},
            },
          },
          initial: {
            search_queries: [
              "OpenAI latest AI blog posts",
              "OpenAI release notes",
            ],
            fetched_urls: [
              "https://openai.com/news",
              "https://openai.com/research",
            ],
            failed_urls: [],
            triage: {
              agent_dispatched: 1,
              agent_succeeded: 1,
              agent_failed: 0,
              agent_reported_step_count: ${JSON.stringify(input.agentReportedStepCount)},
              agent_runs_with_streaming_url: ${JSON.stringify(input.agentRunsWithStreamingUrl)},
              agent_runs_with_explicit_browser_actions: ${JSON.stringify(input.agentRunsWithExplicitBrowserActions)},
            },
          },
          repair: {
            loops: [{
              loop_index: 1,
              repair_queries: ["OpenAI blog official source_url evidence"],
            }],
            stats: {
              triage: {
                agent_dispatched: 2,
                agent_succeeded: 1,
                agent_failed: 1,
              },
            },
          },
          quality: {
            records: [{ record_id: "pk:openai", needs_review: true }],
          },
          search_queries: [
            "OpenAI latest AI blog posts",
            "OpenAI release notes",
          ],
          browser_actions: ${JSON.stringify(input.browserActions ?? [])},
          agent_browser_actions: ${JSON.stringify(input.agentBrowserActions ?? [])},
          fetched_urls: [
            "https://openai.com/news",
            "https://openai.com/research",
          ],
          failed_urls: [],
          sources: ${JSON.stringify(input.sources ?? {
            outcomes: [{
              url: "https://openai.com/news",
              outcome: "success",
              phase: "initial",
              triage_status: "extract_now",
              records_extracted: 1,
            }],
          })},
          llm_usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        records: [{
          row: {
            entity_name: "OpenAI",
            source_url: "https://openai.com/news",
            evidence_quote: options.benchmark.persona,
          },
          source_urls: ["https://openai.com/news"],
          evidence: [{
            field: "entity_name",
            url: "https://openai.com/news",
            quote: options.benchmark.expectedStress,
          }],
        }],
        llmUsage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      };
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function snapshotEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
