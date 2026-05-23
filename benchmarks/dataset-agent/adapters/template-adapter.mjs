#!/usr/bin/env node
import { spawn } from "node:child_process";

const prompt = requiredEnv("BIGSET_BENCHMARK_PROMPT");
const promptId = requiredEnv("BIGSET_BENCHMARK_PROMPT_ID");
const requiredColumns = requiredEnv("BIGSET_BENCHMARK_REQUIRED_COLUMNS")
  .split(",")
  .map((columnName) => columnName.trim())
  .filter(Boolean);
const minimumRequiredColumns = (process.env.BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS ?? "")
  .split(",")
  .map((columnName) => columnName.trim())
  .filter(Boolean);

const agentResult = await runCurrentAgent({
  prompt,
  promptId,
  requiredColumns,
  minimumRequiredColumns,
});

console.log(JSON.stringify(toBenchmarkPayload(agentResult)));

async function runCurrentAgent(input) {
  // Replace this function with the current agent call.
  //
  // Option A: direct JS import
  // const { runDatasetAgent } = await import("../../path/to/agent.js");
  // return runDatasetAgent({ prompt: input.prompt });
  //
  // Option B: existing CLI
  // return runJsonCommand("npm", ["run", "agent:run", "--", input.prompt]);
  //
  // Option C: local HTTP server
  // const response = await fetch("http://localhost:3001/dataset-agent", {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ prompt: input.prompt }),
  // });
  // if (!response.ok) throw new Error(`Agent HTTP ${response.status}`);
  // return response.json();
  //
  // Keep this throw until the real call is wired.
  throw new Error(
    `Wire current agent in ${import.meta.url} for prompt ${input.promptId}.`
  );
}

function toBenchmarkPayload(agentResult) {
  const rows = normalizeRows(agentResult.rows ?? agentResult.data ?? []);
  return {
    rows,
    validationIssues:
      agentResult.validationIssues ?? agentResult.issues ?? agentResult.errors ?? [],
    usage: {
      promptTokens:
        agentResult.usage?.promptTokens ??
        agentResult.usage?.inputTokens ??
        agentResult.inputTokens ??
        0,
      completionTokens:
        agentResult.usage?.completionTokens ??
        agentResult.usage?.outputTokens ??
        agentResult.outputTokens ??
        0,
      totalTokens:
        agentResult.usage?.totalTokens ??
        agentResult.totalTokens ??
        0,
    },
    metrics: {
      searchCalls:
        agentResult.metrics?.searchCalls ?? agentResult.searchCallCount ?? 0,
      fetchCalls:
        agentResult.metrics?.fetchCalls ?? agentResult.fetchCallCount ?? 0,
      browserCalls:
        agentResult.metrics?.browserCalls ?? agentResult.browserCallCount ?? 0,
      agentRuns:
        agentResult.metrics?.agentRuns ?? agentResult.agentRunCount ?? 1,
      agentSteps:
        agentResult.metrics?.agentSteps ?? agentResult.agentStepCount ?? 0,
    },
  };
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const cells = row.cells ?? row.data ?? row;
    const sourceUrls = normalizeSourceUrls(row, cells);
    return {
      cells,
      sourceUrls,
      evidence: normalizeEvidence(row, sourceUrls),
      needsReview: row.needsReview ?? row.needs_review ?? false,
    };
  });
}

function normalizeSourceUrls(row, cells) {
  return [
    ...arrayOfStrings(row.sourceUrls),
    ...arrayOfStrings(row.sources),
    ...arrayOfStrings(row.source_urls),
    ...singleString(row.sourceUrl),
    ...singleString(row.source_url),
    ...singleString(cells.source_url),
    ...singleString(cells.sourceUrl),
  ].filter((value, index, array) => value && array.indexOf(value) === index);
}

function normalizeEvidence(row, sourceUrls) {
  if (Array.isArray(row.evidence)) {
    return row.evidence;
  }
  if (Array.isArray(row.evidenceQuotes)) {
    return row.evidenceQuotes.map((quote) => ({
      columnName: "entity_name",
      sourceUrl: sourceUrls[0] ?? "",
      quote,
    }));
  }
  return [];
}

async function runJsonCommand(command, args) {
  const execution = await runCommand(command, args);
  if (execution.exitCode !== 0) {
    throw new Error(`${command} exited ${execution.exitCode}: ${execution.stderr}`);
  }
  return JSON.parse(execution.stdout);
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run through run-benchmark.mjs.`);
  }
  return value;
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function singleString(value) {
  return typeof value === "string" ? [value] : [];
}
