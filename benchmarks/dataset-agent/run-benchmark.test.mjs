import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  benchmarkStatusForOutcome,
  failureCategoryForOutcome,
  failureReason,
  findInfrastructureBlockerReason,
  normalizePayload,
  playwrightReadinessGateReason,
  rescoreBenchmarkRun,
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

test("Playwright readiness gate fails otherwise passing benchmark output", () => {
  const capabilityGateReason = playwrightReadinessGateReason({
    requirePlaywrightReady: true,
    diagnostics: notReadyDiagnostics(),
  });
  const answerKeyScore = { passed: true, failureCategory: undefined };
  const status = benchmarkStatusForOutcome({
    execution: { exitCode: 0 },
    parsedPayload: { rows: passingRows() },
    answerKeyScore,
    infraBlockerReason: null,
    capabilityGateReason,
  });

  assert.equal(status, "failed");
  assert.match(capabilityGateReason, /no actionable browser steps/i);
  assert.equal(failureCategoryForOutcome({
    status,
    infraBlockerReason: null,
    capabilityGateReason,
    answerKeyScore,
  }), "capability_gate");
  assert.equal(failureReason({
    execution: { exitCode: 0, timedOut: false },
    parsedPayload: { rows: passingRows() },
    validation: passingValidation,
    answerKeyScore,
    infraBlockerReason: null,
    capabilityGateReason,
    minRequiredCompleteness: 0.75,
  }), capabilityGateReason);
});

test("Playwright readiness gate does not override infrastructure blockers", () => {
  const infraBlockerReason = "Infrastructure/auth/credits blocker.";
  const capabilityGateReason = null;
  const answerKeyScore = { passed: true, failureCategory: undefined };
  const status = benchmarkStatusForOutcome({
    execution: { exitCode: 0 },
    parsedPayload: null,
    answerKeyScore,
    infraBlockerReason,
    capabilityGateReason,
  });

  assert.equal(status, "blocked");
  assert.equal(failureCategoryForOutcome({
    status,
    infraBlockerReason,
    capabilityGateReason,
    answerKeyScore,
  }), "infra");
});

test("rescore applies Playwright readiness gate semantics", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "bigset-benchmark-rescore-"));
  const artifactDirectory = join(runDirectory, "collection-self-heal", "01-gate-prompt");
  await mkdir(artifactDirectory, { recursive: true });

  const parsedPayload = {
    rows: passingRows(),
    validationIssues: [],
    diagnostics: notReadyDiagnostics(),
  };
  await writeFile(
    join(runDirectory, "summary.json"),
    JSON.stringify({
      laneResults: [{
        system: "collection-self-heal",
        promptId: "gate-prompt",
        promptQuality: "good",
        artifactDirectory,
        exitCode: 0,
        timedOut: false,
      }],
    })
  );
  await writeFile(
    join(artifactDirectory, "parsed-output.json"),
    JSON.stringify(parsedPayload)
  );
  await writeFile(join(artifactDirectory, "stdout.txt"), JSON.stringify(parsedPayload));
  await writeFile(join(artifactDirectory, "stderr.txt"), "");

  const rescored = await rescoreBenchmarkRun({
    runDirectory,
    prompts: [{
      id: "gate-prompt",
      quality: "good",
      persona: "developer",
      prompt: "Find official docs.",
      expectedStress: "Browser action gate.",
      requiredColumns: ["entity_name", "source_url"],
    }],
    config: {
      promptIds: null,
      minRequiredCompleteness: 0.75,
      minFactualAccuracy: 0.75,
      requirePlaywrightReady: true,
      inputUsdPer1M: 0.05,
      outputUsdPer1M: 0.5,
      tinyFishAgentStepUsd: 0.015,
    },
  });

  assert.equal(rescored.laneResults[0].status, "failed");
  assert.equal(rescored.laneResults[0].failureCategory, "capability_gate");
  assert.match(rescored.laneResults[0].errorMessage, /no actionable browser steps/i);
  assert.equal(rescored.laneResults[0].playwrightCandidateStatus, "not_ready");
});

function passingRows() {
  return [{
    cells: {
      entity_name: "Example",
      source_url: "https://example.com/docs",
    },
    sourceUrls: ["https://example.com/docs"],
    evidence: [{
      columnName: "entity_name",
      sourceUrl: "https://example.com/docs",
      quote: "Example docs",
    }],
  }];
}

function notReadyDiagnostics() {
  return {
    playwrightCandidateReadiness: {
      status: "not_ready",
      reasons: ["Trace has no actionable browser steps with URL/selector/target data."],
      browserStepCount: 0,
      sourceUrlCount: 1,
    },
    processTrace: {
      runtime: "collection",
      stepCount: 3,
      browserStepCount: 0,
      sourceUrlCount: 1,
    },
  };
}
