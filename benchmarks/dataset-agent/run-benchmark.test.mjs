import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failureReason,
  findInfrastructureBlockerReason,
  normalizePayload,
  scoreBenchmarkRows,
} from "./run-benchmark.mjs";
import { selfHealingDiagnosticsFromTick } from "./adapters/self-healing-output.mjs";

const passingValidation = {
  rowCount: 1,
  sourceUrlCount: 1,
  evidenceQuoteCount: 1,
  requiredCellCompletenessRatio: 1,
  missingRequiredCellCount: 0,
};

test("benchmark failure reason prefers capability diagnostic over generic zero rows", () => {
  const diagnostic = "Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up for 2 page(s) (requires_navigation=1, requires_form_submission=1). Enable COLLECTION_AGENT_ENABLE_AGENT=true for live navigation.";

  const reason = failureReason({
    execution: {
      timedOut: false,
      exitCode: 0,
    },
    parsedPayload: {
      rows: [],
      validationIssues: [diagnostic],
    },
    validation: {
      rowCount: 0,
      sourceUrlCount: 0,
      evidenceQuoteCount: 0,
      requiredCellCompletenessRatio: 0,
    },
    answerKeyScore: null,
    infraBlockerReason: null,
    minRequiredCompleteness: 0.75,
    validationIssues: [diagnostic],
  });

  assert.equal(reason, diagnostic);
});

test("infrastructure blocker detection ignores ordinary API-key documentation text", () => {
  const reason = findInfrastructureBlockerReason({
    execution: {
      timedOut: false,
      stderr: "The documentation page covers general API key setup and SDK usage.",
      stdout: "",
    },
    parsedPayload: {
      rows: [{
        cells: {
          summary: "Covers API key setup for developers.",
        },
      }],
    },
    normalized: {
      validationIssues: [
        "Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up for 1 page(s) (requires_navigation=1). Enable COLLECTION_AGENT_ENABLE_AGENT=true for live navigation.",
      ],
    },
  });

  assert.equal(reason, null);
});

test("infrastructure blocker detection still catches missing API key configuration", () => {
  const reason = findInfrastructureBlockerReason({
    execution: {
      timedOut: false,
      stderr: "Missing OPENROUTER_API_KEY.",
      stdout: "",
    },
    parsedPayload: null,
    normalized: {
      validationIssues: [],
    },
  });

  assert.equal(reason, "Infrastructure/auth/credits blocker.");
});

test("domain scoring counts official website cells as source evidence", () => {
  const score = scoreBenchmarkRows({
    rows: [{
      cells: {
        entity_name: "MoMo",
        official_website: "https://momo.vn",
        source_url: "https://example-directory.test/vietnam-fintech",
      },
      evidence: [{ quote: "MoMo official website is https://momo.vn" }],
    }],
    validation: passingValidation,
    validationIssues: [],
    minRequiredCompleteness: 1,
    minFactualAccuracy: 0.75,
    promptDefinition: {
      answerKey: {
        expectedBehavior: "answer",
        requiredColumns: ["entity_name", "official_website", "source_url"],
        expectedEntities: [{
          label: "MoMo",
          aliases: ["momo"],
          allowedSourceDomains: ["momo.vn"],
        }],
        minimumExpectedEntityMatches: 1,
      },
    },
  });

  assert.equal(score.passed, true);
  assert.equal(score.domainAccuracyRatio, 1);
});

test("domain scoring counts product, careers, and docs URL cells", () => {
  const cases = [
    {
      cells: {
        bakery_name: "Bakes",
        product_name: "Croissant",
        product_url: "https://bakes-saigon.com/products/croissant",
        source_url: "https://example-directory.test/bakeries",
      },
      label: "Bakes",
      aliases: ["bakes"],
      allowedSourceDomains: ["bakes-saigon.com"],
    },
    {
      cells: {
        entity_name: "Runway",
        careers_page_url: "https://runwayml.com/careers",
        source_url: "https://example-directory.test/ai-startups",
      },
      label: "Runway",
      aliases: ["runway"],
      allowedSourceDomains: ["runwayml.com"],
    },
    {
      cells: {
        entity_name: "Cloudflare",
        docs_url: "https://developers.cloudflare.com/agents/model-context-protocol/",
        source_url: "https://example-directory.test/mcp-docs",
      },
      label: "Cloudflare",
      aliases: ["cloudflare"],
      allowedSourceDomains: ["developers.cloudflare.com"],
    },
  ];

  for (const item of cases) {
    const score = scoreBenchmarkRows({
      rows: [{
        cells: item.cells,
        evidence: [{ quote: JSON.stringify(item.cells) }],
      }],
      validation: passingValidation,
      validationIssues: [],
      minRequiredCompleteness: 1,
      minFactualAccuracy: 0.75,
      promptDefinition: {
        answerKey: {
          expectedBehavior: "answer",
          requiredColumns: Object.keys(item.cells),
          expectedEntities: [{
            label: item.label,
            aliases: item.aliases,
            allowedSourceDomains: item.allowedSourceDomains,
          }],
          minimumExpectedEntityMatches: 1,
        },
      },
    });

    assert.equal(score.passed, true, `${item.label} should pass`);
    assert.equal(score.domainAccuracyRatio, 1, `${item.label} domain`);
  }
});

test("self-healing diagnostics summarize trace and readiness artifacts", () => {
  const diagnostics = selfHealingDiagnosticsFromTick({
    tick: { action: "generated_initial_recipe" },
    run: {
      recipeId: "recipe-v1",
      artifacts: [
        {
          kind: "process-trace",
          content: JSON.stringify({
            runtime: "collection",
            searchQueries: ["example"],
            fetchedUrls: ["https://example.com"],
            sourceArtifacts: [{
              url: "https://example.com",
              status: "succeeded",
            }],
            steps: [
              { kind: "search" },
              { kind: "browser" },
            ],
          }),
        },
        {
          kind: "playwright-candidate-readiness",
          content: JSON.stringify({
            status: "ready",
            reasons: [],
            browserStepCount: 1,
            sourceUrlCount: 1,
          }),
        },
      ],
    },
  });
  const normalized = normalizePayload({
    rows: [],
    validationIssues: [],
    diagnostics,
  });

  assert.equal(normalized.diagnostics.selfHealingAction, "generated_initial_recipe");
  assert.deepEqual(normalized.diagnostics.artifactKinds, [
    "process-trace",
    "playwright-candidate-readiness",
  ]);
  assert.equal(normalized.diagnostics.processTrace.runtime, "collection");
  assert.equal(normalized.diagnostics.processTrace.stepCount, 2);
  assert.equal(normalized.diagnostics.processTrace.browserStepCount, 1);
  assert.equal(
    normalized.diagnostics.playwrightCandidateReadiness.status,
    "ready"
  );
});
