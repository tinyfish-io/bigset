import assert from "node:assert/strict";
import { test } from "node:test";

import { playwrightCandidateReadinessForRun } from "../src/pipeline/populate-playwright-readiness.js";
import type { PopulateRuntimeResult } from "../src/pipeline/populate-runtime.js";

test("Playwright candidate readiness rejects search/fetch-only traces", () => {
  const readiness = playwrightCandidateReadinessForRun({
    result: runtimeResult({
      processTrace: {
        runtime: "collection",
        searchQueries: ["OpenAI latest blog"],
        fetchedUrls: ["https://openai.com/news"],
        sourceArtifacts: [{
          url: "https://openai.com/news",
          status: "succeeded",
          source: "fetch",
          label: "news",
        }],
        selectedRowSource: "collection_pipeline",
        notes: [],
        steps: [{
          kind: "fetch",
          label: "collection-fetched-url",
          status: "succeeded",
          input: { url: "https://openai.com/news" },
        }],
      },
    }),
  });

  assert.equal(readiness.status, "not_ready");
  assert.equal(readiness.browserStepCount, 0);
  assert.match(readiness.reasons.join("\n"), /no actionable browser steps/i);
});

test("Playwright candidate readiness rejects Agent-disabled capability diagnostics", () => {
  const readiness = playwrightCandidateReadinessForRun({
    result: runtimeResult({
      validationIssues: [
        "Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up for 1 page(s).",
      ],
      processTrace: {
        runtime: "collection",
        searchQueries: [],
        fetchedUrls: ["https://example.com/form"],
        sourceArtifacts: [{
          url: "https://example.com/form",
          status: "succeeded",
          source: "fetch",
        }],
        selectedRowSource: "collection_pipeline",
        notes: [],
        steps: [{
          kind: "browser",
          label: "agent-navigation",
          status: "succeeded",
          browserAction: {
            action: "navigate",
            url: "https://example.com/form",
          },
        }],
      },
    }),
  });

  assert.equal(readiness.status, "not_ready");
  assert.match(readiness.reasons.join("\n"), /Agent\/browser follow-up/i);
});

test("Playwright candidate readiness accepts browser-action traces anchored to sources", () => {
  const readiness = playwrightCandidateReadinessForRun({
    result: runtimeResult({
      processTrace: {
        runtime: "collection",
        searchQueries: [],
        fetchedUrls: ["https://example.com/form"],
        sourceArtifacts: [{
          url: "https://example.com/form",
          status: "succeeded",
          source: "agent",
          label: "browser-canary",
        }],
        selectedRowSource: "collection_pipeline",
        notes: [],
        steps: [{
          kind: "browser",
          label: "agent-form-submit",
          status: "succeeded",
          browserAction: {
            action: "click",
            url: "https://example.com/form",
            selector: "button[type=submit]",
          },
        }],
      },
    }),
  });

  assert.equal(readiness.status, "ready");
  assert.deepEqual(readiness.reasons, []);
  assert.equal(readiness.browserStepCount, 1);
  assert.equal(readiness.sourceUrlCount, 1);
});

function runtimeResult(input: {
  validationIssues?: string[];
  processTrace?: NonNullable<PopulateRuntimeResult["debug"]>["processTrace"];
}): PopulateRuntimeResult {
  return {
    rows: [{
      cells: {
        entity_name: "OpenAI",
        source_url: "https://openai.com/news",
        evidence_quote: "Release notes",
      },
      sourceUrls: ["https://openai.com/news"],
      evidence: [{
        columnName: "evidence_quote",
        sourceUrl: "https://openai.com/news",
        quote: "Release notes",
      }],
      needsReview: false,
    }],
    validationIssues: input.validationIssues ?? [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metrics: {
      searchCalls: 0,
      fetchCalls: 0,
      browserCalls: 0,
      agentRuns: 0,
      agentSteps: 0,
    },
    debug: input.processTrace
      ? {
          capturedRows: [],
          capturedSources: [],
          selectedRowSource: "collection_pipeline",
          notes: [],
          processTrace: input.processTrace,
        }
      : undefined,
  };
}
