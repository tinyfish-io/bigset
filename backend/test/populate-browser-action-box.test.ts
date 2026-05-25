import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  BrowserActionBox,
  classifyReplayFailure,
  createPlaywrightScriptArtifact,
  validateReplayAgentCompatibleResult,
} from "../src/pipeline/populate-browser-action-box.js";
import {
  buildPopulateFetchPlan,
  directRowsFromFetchedPage,
  rankPopulateSearchResults,
  triageFetchedPageForPopulate,
} from "../src/pipeline/populate-source-planner.js";
import { normalizeTinyFishRecordedTrace } from "../src/pipeline/populate-tinyfish-trace-recorder.js";
import {
  createDeterministicPlaywrightRepair,
  createLocalPlaywrightReplayRunner,
} from "../src/pipeline/populate-playwright-replay-runner.js";
import type { DatasetContext } from "../src/pipeline/populate.js";

const context: DatasetContext = {
  datasetId: "dataset-browser-action-box",
  datasetName: "Browser action box",
  description: "Find official pricing pages for OpenAI and Anthropic.",
  columns: [
    {
      name: "provider",
      type: "text",
      description: "Provider name.",
    },
    {
      name: "source_url",
      type: "url",
      description: "Official source URL.",
    },
    {
      name: "evidence_quote",
      type: "text",
      description: "Evidence quote.",
    },
  ],
};

const browserSchema = {
  columns: context.columns.map((column) => ({
    name: column.name,
    description: column.description,
    required: true,
  })),
};

test("source planner ranks, dedupes, deprioritizes low-trust URLs, and caps fetches", () => {
  const ranked = rankPopulateSearchResults({
    context,
    results: [
      {
        title: "Someone discusses OpenAI pricing",
        snippet: "A forum thread.",
        url: "https://reddit.com/r/openai/comments/1",
      },
      {
        title: "OpenAI API Pricing",
        snippet: "Official API pricing for current public models.",
        url: "https://openai.com/api/pricing#models",
      },
      {
        title: "OpenAI API Pricing duplicate",
        snippet: "Official docs and pricing.",
        url: "https://openai.com/api/pricing",
      },
      {
        title: "Anthropic pricing",
        snippet: "Official Claude pricing details and docs.",
        url: "https://docs.anthropic.com/en/docs/about-claude/pricing",
      },
    ],
  });

  assert.equal(ranked.length, 3);
  assert.deepEqual(
    ranked.slice(0, 2).map((result) => result.canonicalUrl).sort(),
    [
      "https://docs.anthropic.com/en/docs/about-claude/pricing",
      "https://openai.com/api/pricing",
    ]
  );
  assert.ok((ranked[0]?.expectationScore ?? 0) > (ranked[2]?.expectationScore ?? 0));
  assert.match(ranked[2]?.lowTrustReason ?? "", /low-trust/);
  assert.deepEqual(buildPopulateFetchPlan({ rankedResults: ranked, fetchLimit: 2 }).sort(), [
    "https://docs.anthropic.com/en/docs/about-claude/pricing",
    "https://openai.com/api/pricing",
  ]);
});

test("fetch triage separates direct extraction from browser-heavy pages", () => {
  const direct = triageFetchedPageForPopulate({
    context,
    url: "https://openai.com/api/pricing",
    page: {
      title: "OpenAI API Pricing",
      text: "OpenAI official pricing. Input tokens and output tokens are listed for every model.".repeat(4),
    },
  });
  assert.equal(direct.status, "extract_now");

  const form = triageFetchedPageForPopulate({
    context,
    url: "https://example.com/locator",
    page: {
      title: "Location finder",
      text: "Enter your zip code and submit the form to search current locations.",
    },
  });
  assert.equal(form.status, "requires_form_submission");

  const blocked = triageFetchedPageForPopulate({
    context,
    url: "https://example.com/protected",
    page: {
      title: "Verify",
      text: "Please verify you are human. Captcha required.",
    },
  });
  assert.equal(blocked.status, "blocked");
});

test("direct fetch extraction only fills title/url schemas without browser spend", () => {
  const rows = directRowsFromFetchedPage({
    context: {
      ...context,
      columns: [
        { name: "Post Title", type: "text", description: "Title." },
        { name: "Post URL", type: "url", description: "URL." },
      ],
    },
    url: "https://openai.com/news/product-releases/introducing-gpt-5",
    page: {
      title: "Introducing GPT-5",
      text: "Introducing GPT-5\nOpenAI product release details.",
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.cells["Post Title"], "Introducing GPT-5");
  assert.equal(
    rows[0]?.cells["Post URL"],
    "https://openai.com/news/product-releases/introducing-gpt-5"
  );
  assert.equal(rows[0]?.evidence[0]?.quote, "Introducing GPT-5");
});

test("BrowserActionBox first run records TinyFish trace and emits draft script when actions are explicit", async () => {
  const box = new BrowserActionBox({
    now: () => new Date("2026-05-24T00:00:00.000Z"),
    tinyFishClient: {
      async runAgent() {
        return {
          runId: "run-123",
          status: "COMPLETED",
          sseEvents: [{ type: "PROGRESS", message: "Clicked Pricing" }],
          runDetail: {
            run_id: "run-123",
            status: "COMPLETED",
            streaming_url: "https://agent.tinyfish.ai/runs/run-123/live",
            steps: [{
              id: "step-1",
              action: "navigate",
              status: "completed",
              url: "https://openai.com/api/pricing",
              screenshot_url: "https://agent.tinyfish.ai/runs/run-123/step-1.jpg",
            }, {
              id: "step-2",
              action: "click",
              status: "completed",
              target_text: "Pricing",
              url: "https://openai.com/api/pricing",
            }],
          },
          finalResult: {
            records: [{
              provider: "OpenAI",
              source_url: "https://openai.com/api/pricing",
              evidence_quote: "OpenAI official pricing",
              evidence: [{
                field: "provider",
                url: "https://openai.com/api/pricing",
                quote: "OpenAI official pricing",
              }],
            }],
            agent_browser_actions: [{
              action: "click",
              url: "https://openai.com/api/pricing",
              target_text: "Pricing",
              status: "succeeded",
            }],
          },
        };
      },
    },
  });

  const output = await box.firstRun({
    sourceUrl: "https://openai.com/api/pricing",
    datasetGoalPrompt: context.description,
    datasetSchema: browserSchema,
    runCaps: {
      maxAgentSteps: 8,
      maxDurationSeconds: 120,
      captureHtml: true,
      captureScreenshots: true,
    },
  });

  assert.equal(output.trace.runId, "run-123");
  assert.equal(output.trace.normalizedBrowserActions.length, 2);
  assert.equal(output.runtimeResult.rows.length, 1);
  assert.equal(output.replayReadiness.status, "ready");
  assert.ok(output.playwrightScript);
  assert.match(output.playwrightScript?.code ?? "", /runDatasetRecipe/);
  assert.ok(
    output.runtimeResult.debug?.diagnosticArtifacts?.some((artifact) =>
      artifact.kind === "tinyfish-trace"
    )
  );
});

test("BrowserActionBox first run accepts raw TinyFish result arrays and raw run steps", async () => {
  const box = new BrowserActionBox({
    now: () => new Date("2026-05-24T00:00:00.000Z"),
    tinyFishClient: {
      async runAgent() {
        return {
          runId: "run-raw",
          status: "COMPLETED",
          sseEvents: [{
            type: "PROGRESS",
            purpose: "Extract article cards.",
            timestamp: "2026-05-24T00:00:00.000Z",
            streaming_url: "https://agent.tinyfish.ai/private-preview",
          }],
          runDetail: {
            run_id: "run-raw",
            status: "COMPLETED",
            steps: [{
              id: "step-1",
              status: "RUNNING",
              action: "Navigate to the source page.",
              screenshot: "https://agent.tinyfish.ai/runs/run-raw/step-1.jpg",
              duration: 1000,
            }, {
              id: "step-2",
              status: "RUNNING",
              action: "Extract titles and URLs.",
              html: "https://agent.tinyfish.ai/runs/run-raw/step-2.html",
              duration: 500,
            }],
          },
          finalResult: {
            result: [{
              provider: "OpenAI",
              source_url: "https://openai.com/api/pricing",
              evidence_quote: "OpenAI official pricing",
              agent_browser_actions: [
                "visit_url_tool: https://openai.com/api/pricing",
              ],
            }],
          },
        };
      },
    },
  });

  const output = await box.firstRun({
    sourceUrl: "https://openai.com/api/pricing",
    datasetGoalPrompt: context.description,
    datasetSchema: browserSchema,
    runCaps: {
      maxAgentSteps: 8,
      maxDurationSeconds: 120,
      captureHtml: true,
      captureScreenshots: true,
    },
  });

  assert.equal(output.runtimeResult.rows.length, 1);
  assert.equal(output.runtimeResult.rows[0]?.evidence[0]?.quote, "OpenAI official pricing");
  assert.equal(output.replayReadiness.status, "ready");
  assert.ok(output.playwrightScript);
  assert.ok(output.trace.artifactRefs.some((artifact) => artifact.kind === "screenshot"));
  assert.ok(output.trace.artifactRefs.some((artifact) => artifact.kind === "html"));
});

test("TinyFish trace normalization redacts streaming URLs from SSE data", () => {
  const trace = normalizeTinyFishRecordedTrace({
    sourceUrl: "https://openai.com/api/pricing",
    goal: "Collect pricing.",
    runId: "run-redacted",
    status: "COMPLETED",
    sseEvents: [{
      type: "PROGRESS",
      purpose: "Click pricing.",
      streaming_url: "https://agent.tinyfish.ai/private-preview",
      timestamp: "2026-05-24T00:00:00.000Z",
    }],
    runDetail: {
      run_id: "run-redacted",
      status: "COMPLETED",
      steps: [{
        id: "step-1",
        action: "Navigate to source page.",
        status: "COMPLETED",
      }],
    },
    finalResult: { result: [] },
  });

  assert.equal(trace.sseEvents[0]?.message, "Click pricing.");
  assert.equal(trace.sseEvents[0]?.data?.streaming_url, undefined);
  assert.equal(trace.normalizedBrowserActions[0]?.url, "https://openai.com/api/pricing");
});

test("BrowserActionBox replay returns candidate rows without calling TinyFish Agent", async () => {
  let tinyFishCalls = 0;
  let replayCalls = 0;
  const script = scriptArtifact("console.log('replay');");
  const box = new BrowserActionBox({
    tinyFishClient: {
      async runAgent() {
        tinyFishCalls += 1;
        throw new Error("TinyFish should not run during replay");
      },
    },
    async runPlaywrightScript() {
      replayCalls += 1;
      return {
        agentCompatibleResult: agentCompatibleRows(),
        trace: {
          status: "succeeded",
          steps: [{
            kind: "browser",
            label: "playwright-replay",
            status: "succeeded",
          }],
        },
      };
    },
  });

  const output = await box.replay(replayInput(script));

  assert.equal(output.replayStatus, "replay_succeeded");
  assert.equal(output.runtimeResult?.rows.length, 1);
  assert.equal(tinyFishCalls, 0);
  assert.equal(replayCalls, 1);
});

test("BrowserActionBox repair is one-shot and only emits repaired script after validation passes", async () => {
  const calls: string[] = [];
  const script = scriptArtifact("throw new Error('stale selector');");
  const repaired = scriptArtifact("console.log('repaired');");
  const box = new BrowserActionBox({
    tinyFishClient: {
      async runAgent() {
        throw new Error("TinyFish should not run during replay repair");
      },
    },
    async runPlaywrightScript({ script: currentScript }) {
      calls.push(currentScript.code);
      if (currentScript.code.includes("stale selector")) {
        return {
          agentCompatibleResult: null,
          error: "locator button.old timed out",
          trace: {
            status: "failed",
            failedStepIndex: 1,
            failedAction: "click old button",
            currentUrl: "https://openai.com/api/pricing",
          },
        };
      }
      return {
        agentCompatibleResult: agentCompatibleRows(),
        trace: { status: "succeeded" },
      };
    },
    async repairPlaywrightScript() {
      return repaired;
    },
  });

  const output = await box.replay(replayInput(script));

  assert.equal(output.replayStatus, "repair_promoted");
  assert.equal(output.repairedPlaywrightScript?.code, repaired.code);
  assert.deepEqual(calls, [script.code, repaired.code]);
});

test("local Playwright replay runner executes a script and extracts rows", {
  skip: !localChromiumExecutable(),
}, async () => {
  const sourceUrl = "https://example.com/releases";
  const datasetSchema = {
    columns: [
      { name: "post_title", required: true },
      { name: "post_url", required: true },
      { name: "evidence_quote", required: true },
    ],
  };
  const script = createPlaywrightScriptArtifact({
    sourceUrl,
    datasetGoalPrompt: "Collect product releases with titles, URLs, and evidence.",
    datasetSchema,
    code: `
      export async function runDatasetRecipe(context) {
        await context.page.setContent(\`
          <main>
            <a href="https://example.com/releases/alpha">Alpha product release May 1, 2026</a>
            <a href="https://example.com/releases/beta">Beta product release May 2, 2026</a>
          </main>
        \`);
        return { rows: [] };
      }
    `,
    status: "promoted",
    createdAt: "2026-05-24T00:00:00.000Z",
  });
  const runner = createLocalPlaywrightReplayRunner({
    executablePath: localChromiumExecutable(),
  });

  const output = await runner({
    sourceUrl,
    datasetGoalPrompt: "Collect product releases with titles, URLs, and evidence.",
    datasetSchema,
    currentPlaywrightScript: script,
    script,
    previousSuccessfulOutputProfile: {
      fieldsPreviouslyRetrieved: ["post_title", "post_url", "evidence_quote"],
      rowCountRange: { min: 2 },
      sourceUrls: [sourceUrl],
      evidenceRequired: true,
    },
    runCaps: {
      maxReplayAttempts: 1,
      maxRepairAttempts: 1,
      timeoutMs: 15_000,
    },
  });

  assert.equal(output.error, undefined);
  assert.equal(output.trace?.status, "succeeded");
  assert.equal(
    validateReplayAgentCompatibleResult({
      agentCompatibleResult: output.agentCompatibleResult,
      profile: {
        fieldsPreviouslyRetrieved: ["post_title", "post_url", "evidence_quote"],
        rowCountRange: { min: 2 },
        sourceUrls: [sourceUrl],
        evidenceRequired: true,
      },
    }).isValid,
    true
  );
});

test("local Playwright replay runner extracts current page evidence when links are absent", {
  skip: !localChromiumExecutable(),
}, async () => {
  const sourceUrl = "https://example.com/releases";
  const datasetSchema = {
    columns: [
      { name: "page_title", required: true },
      { name: "source_url", required: true },
      { name: "evidence_quote", required: true },
    ],
  };
  const script = createPlaywrightScriptArtifact({
    sourceUrl,
    datasetGoalPrompt: "Collect page title, URL, and visible evidence.",
    datasetSchema,
    code: `
      export async function runDatasetRecipe(context) {
        await context.page.setContent(\`
          <main>
            <h1>Example release notes</h1>
            <p>Visible release evidence from the current public page.</p>
          </main>
        \`);
        return { rows: [] };
      }
    `,
    status: "promoted",
    createdAt: "2026-05-24T00:00:00.000Z",
  });
  const runner = createLocalPlaywrightReplayRunner({
    executablePath: localChromiumExecutable(),
  });

  const output = await runner({
    sourceUrl,
    datasetGoalPrompt: "Collect page title, URL, and visible evidence.",
    datasetSchema,
    currentPlaywrightScript: script,
    script,
    previousSuccessfulOutputProfile: {
      fieldsPreviouslyRetrieved: ["page_title", "source_url", "evidence_quote"],
      rowCountRange: { min: 1 },
      sourceUrls: [sourceUrl],
      evidenceRequired: true,
    },
    runCaps: {
      maxReplayAttempts: 1,
      maxRepairAttempts: 1,
      timeoutMs: 15_000,
    },
  });

  assert.equal(output.error, undefined);
  assert.equal(
    validateReplayAgentCompatibleResult({
      agentCompatibleResult: output.agentCompatibleResult,
      profile: {
        fieldsPreviouslyRetrieved: ["page_title", "source_url", "evidence_quote"],
        rowCountRange: { min: 1 },
        sourceUrls: [sourceUrl],
        evidenceRequired: true,
      },
    }).isValid,
    true
  );
});

test("deterministic Playwright repair retargets generated script URLs to the source URL", async () => {
  const repair = createDeterministicPlaywrightRepair();
  const broken = createPlaywrightScriptArtifact({
    sourceUrl: "https://example.com/releases",
    datasetGoalPrompt: context.description,
    datasetSchema: browserSchema,
    code: `
      const browserActions = [{"action":"navigate","url":"https://example.invalid/broken"}];
      const sourceUrls = ["https://example.invalid/broken"];
      export async function runDatasetRecipe() { return { rows: [], sourceUrls }; }
    `,
    status: "promoted",
    createdAt: "2026-05-24T00:00:00.000Z",
  });

  const repaired = await repair({
    ...replayInput(broken),
    sourceUrl: "https://example.com/releases",
    failedReplay: {
      status: "failed",
      startedAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:00:01.000Z",
      scriptId: broken.scriptId,
      sourceUrl: "https://example.com/releases",
      currentUrl: "https://example.invalid/broken",
      error: "navigation failed",
      diagnostics: ["script failure"],
      steps: [],
    },
    diagnostics: ["script failure"],
  });

  assert.ok(repaired);
  assert.match(repaired.code, /https:\/\/example\.com\/releases/);
  assert.doesNotMatch(repaired.code, /example\.invalid/);
});

test("replay validation and classification distinguish broken scripts from validation failures", () => {
  assert.deepEqual(
    validateReplayAgentCompatibleResult({
      agentCompatibleResult: { records: [] },
      profile: {
        fieldsPreviouslyRetrieved: ["provider"],
        rowCountRange: { min: 1 },
        sourceUrls: ["https://openai.com/api/pricing"],
        evidenceRequired: true,
      },
    }),
    {
      isValid: false,
      issues: [
        "Replay returned 0 row(s), below previous minimum 1.",
        "Replay missed previously retrieved field(s): provider.",
        "Replay returned no evidence-backed rows.",
      ],
    }
  );

  assert.equal(
    classifyReplayFailure({
      replayTrace: {
        status: "failed",
        startedAt: "2026-05-24T00:00:00.000Z",
        completedAt: "2026-05-24T00:00:01.000Z",
        scriptId: "script",
        sourceUrl: "https://example.com",
        error: "locator timed out",
        diagnostics: [],
        steps: [],
      },
      validationIssues: [],
    }),
    "script failure"
  );
  assert.equal(
    classifyReplayFailure({
      replayTrace: {
        status: "failed",
        startedAt: "2026-05-24T00:00:00.000Z",
        completedAt: "2026-05-24T00:00:01.000Z",
        scriptId: "script",
        sourceUrl: "https://example.com",
        error: "Captcha required",
        diagnostics: [],
        steps: [],
      },
      validationIssues: [],
    }),
    "blocked/captcha/auth wall"
  );
});

function replayInput(script: ReturnType<typeof scriptArtifact>) {
  return {
    sourceUrl: "https://openai.com/api/pricing",
    datasetGoalPrompt: context.description,
    datasetSchema: browserSchema,
    currentPlaywrightScript: script,
    previousSuccessfulOutputProfile: {
      fieldsPreviouslyRetrieved: ["provider", "source_url", "evidence_quote"],
      rowCountRange: { min: 1 },
      sourceUrls: ["https://openai.com/api/pricing"],
      evidenceRequired: true,
    },
    runCaps: {
      maxReplayAttempts: 1 as const,
      maxRepairAttempts: 1 as const,
      timeoutMs: 30_000,
    },
  };
}

function scriptArtifact(code: string) {
  return createPlaywrightScriptArtifact({
    sourceUrl: "https://openai.com/api/pricing",
    datasetGoalPrompt: context.description,
    datasetSchema: browserSchema,
    code,
    status: "promoted",
    createdAt: "2026-05-24T00:00:00.000Z",
  });
}

function agentCompatibleRows() {
  return {
    records: [{
      provider: "OpenAI",
      source_url: "https://openai.com/api/pricing",
      evidence_quote: "OpenAI official pricing",
      evidence: [{
        field: "provider",
        url: "https://openai.com/api/pricing",
        quote: "OpenAI official pricing",
      }],
    }],
  };
}

function localChromiumExecutable(): string | undefined {
  return [
    process.env.POPULATE_PLAYWRIGHT_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}
