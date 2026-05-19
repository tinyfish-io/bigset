#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPromptsPath = join(scriptDir, "prompts.json");

const config = parseArgs(process.argv.slice(2));
const prompts = JSON.parse(await readFile(config.promptsPath, "utf8"));
const runStartedAt = new Date();
const runDirectory = config.outDirectory ?? join(
  process.cwd(),
  "benchmark-results",
  runStartedAt.toISOString().replace(/[:.]/g, "-")
);

if (config.systems.length === 0) {
  console.error("No systems configured. Pass --system name='command with {{promptJson}}'.");
  process.exit(1);
}

await mkdir(runDirectory, { recursive: true });

const laneResults = [];
for (const system of config.systems) {
  for (const [promptIndex, promptDefinition] of prompts.entries()) {
    const result = await runSystemPrompt({
      system,
      promptDefinition,
      promptIndex,
      promptCount: prompts.length,
      runDirectory,
      config,
    });
    laneResults.push(result);
  }
}

const summary = {
  testedAt: runStartedAt.toISOString(),
  completedAt: new Date().toISOString(),
  wallClockMs: Date.now() - runStartedAt.getTime(),
  promptCount: prompts.length,
  promptMix: promptMixSummary(prompts),
  systems: config.systems.map(({ name }) => name),
  costAssumptions: {
    inputUsdPer1M: config.inputUsdPer1M,
    outputUsdPer1M: config.outputUsdPer1M,
    tinyFishAgentStepUsd: config.tinyFishAgentStepUsd,
  },
  aggregate: aggregateResults(laneResults),
  laneResults,
};

await writeJson(join(runDirectory, "summary.json"), summary);
await writeMarkdownReport(join(runDirectory, "benchmark-report.md"), summary, prompts);
console.log(JSON.stringify(summary, null, 2));

async function runSystemPrompt(input) {
  const startedAt = Date.now();
  const command = renderCommand(input.system.command, input.promptDefinition);
  console.error(
    `[${input.system.name}] ${input.promptIndex + 1}/${input.promptCount} ${input.promptDefinition.id}`
  );

  const execution = await runCommand({
    command,
    timeoutMs: input.config.timeoutMs,
    env: {
      BIGSET_BENCHMARK_PROMPT: input.promptDefinition.prompt,
      BIGSET_BENCHMARK_PROMPT_ID: input.promptDefinition.id,
      BIGSET_BENCHMARK_PROMPT_QUALITY: input.promptDefinition.quality,
      BIGSET_BENCHMARK_REQUIRED_COLUMNS: input.promptDefinition.requiredColumns.join(","),
    },
  });
  const parsedPayload = parseJsonPayload(execution.stdout);
  const normalized = normalizePayload(parsedPayload);
  const validation = evaluateRows({
    rows: normalized.rows,
    promptDefinition: input.promptDefinition,
  });
  const usage = normalized.usage;
  const estimatedModelCostUsd = estimateModelCostUsd(usage, input.config);
  const estimatedTinyFishAgentCostUsd = roundUsd(
    normalized.metrics.agentStepCount * input.config.tinyFishAgentStepUsd
  );
  const status = execution.exitCode === 0 &&
    parsedPayload &&
    validation.rowCount > 0 &&
    validation.sourceUrlCount > 0 &&
    validation.evidenceQuoteCount > 0 &&
    validation.requiredCellCompletenessRatio >= input.config.minRequiredCompleteness
    ? "ok"
    : "failed";

  const promptRunDirectory = join(
    input.runDirectory,
    input.system.name,
    `${String(input.promptIndex + 1).padStart(2, "0")}-${input.promptDefinition.id}`
  );
  await mkdir(promptRunDirectory, { recursive: true });
  await writeFile(join(promptRunDirectory, "stdout.txt"), execution.stdout);
  await writeFile(join(promptRunDirectory, "stderr.txt"), execution.stderr);
  await writeJson(join(promptRunDirectory, "parsed-output.json"), parsedPayload ?? {
    error: "No JSON object found in stdout.",
  });

  return {
    system: input.system.name,
    promptId: input.promptDefinition.id,
    promptQuality: input.promptDefinition.quality,
    promptPersona: input.promptDefinition.persona,
    prompt: input.promptDefinition.prompt,
    requiredColumns: input.promptDefinition.requiredColumns,
    expectedStress: input.promptDefinition.expectedStress,
    status,
    latencyMs: Date.now() - startedAt,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    rowCount: validation.rowCount,
    nonEmptyCellCount: validation.nonEmptyCellCount,
    totalExpectedCellCount: validation.totalExpectedCellCount,
    requiredCellCompletenessRatio: validation.requiredCellCompletenessRatio,
    sourceUrlCount: validation.sourceUrlCount,
    evidenceQuoteCount: validation.evidenceQuoteCount,
    duplicateIdentityCount: validation.duplicateIdentityCount,
    missingRequiredCellCount: validation.missingRequiredCellCount,
    missingRequiredCells: validation.missingRequiredCells,
    needsReviewCount: validation.needsReviewCount,
    validationIssueCount: normalized.validationIssues.length,
    validationIssues: normalized.validationIssues,
    usage,
    searchCallCount: normalized.metrics.searchCallCount,
    fetchCallCount: normalized.metrics.fetchCallCount,
    browserCallCount: normalized.metrics.browserCallCount,
    agentRunCount: normalized.metrics.agentRunCount,
    agentStepCount: normalized.metrics.agentStepCount,
    estimatedModelCostUsd,
    estimatedTinyFishAgentCostUsd,
    estimatedTotalCostUsd: roundUsd(estimatedModelCostUsd + estimatedTinyFishAgentCostUsd),
    artifactDirectory: promptRunDirectory,
    errorMessage: status === "ok"
      ? undefined
      : failureReason({ execution, parsedPayload, validation }),
  };
}

function parseArgs(args) {
  const config = {
    promptsPath: defaultPromptsPath,
    systems: [],
    timeoutMs: 10 * 60 * 1000,
    inputUsdPer1M: 0.05,
    outputUsdPer1M: 0.5,
    tinyFishAgentStepUsd: 0.015,
    minRequiredCompleteness: 0.75,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--prompts") {
      config.promptsPath = value;
      index += 1;
    } else if (arg === "--out") {
      config.outDirectory = value;
      index += 1;
    } else if (arg === "--system") {
      const parsed = parseSystem(value);
      config.systems.push(parsed);
      index += 1;
    } else if (arg === "--timeout-ms") {
      config.timeoutMs = positiveNumber(value, config.timeoutMs);
      index += 1;
    } else if (arg === "--input-usd-per-1m") {
      config.inputUsdPer1M = nonNegativeNumber(value, config.inputUsdPer1M);
      index += 1;
    } else if (arg === "--output-usd-per-1m") {
      config.outputUsdPer1M = nonNegativeNumber(value, config.outputUsdPer1M);
      index += 1;
    } else if (arg === "--tinyfish-agent-step-usd") {
      config.tinyFishAgentStepUsd = nonNegativeNumber(value, config.tinyFishAgentStepUsd);
      index += 1;
    } else if (arg === "--min-required-completeness") {
      config.minRequiredCompleteness = nonNegativeNumber(value, config.minRequiredCompleteness);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

function parseSystem(value) {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error("--system must look like name=command");
  }

  return {
    name: value.slice(0, separatorIndex).trim(),
    command: value.slice(separatorIndex + 1).trim(),
  };
}

function renderCommand(command, promptDefinition) {
  return command
    .replaceAll("{{prompt}}", shellEscape(promptDefinition.prompt))
    .replaceAll("{{promptJson}}", shellEscape(JSON.stringify(promptDefinition.prompt)))
    .replaceAll("{{promptId}}", shellEscape(promptDefinition.id))
    .replaceAll("{{requiredColumnsJson}}", shellEscape(JSON.stringify(promptDefinition.requiredColumns)));
}

function runCommand({ command, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut });
    });
  });
}

function parseJsonPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lastObject = extractLastJsonObject(trimmed);
    if (!lastObject) {
      return null;
    }
    try {
      return JSON.parse(lastObject);
    } catch {
      return null;
    }
  }
}

function extractLastJsonObject(value) {
  let depth = 0;
  let endIndex = -1;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (char === "}") {
      if (endIndex === -1) {
        endIndex = index;
      }
      depth += 1;
    } else if (char === "{") {
      depth -= 1;
      if (depth === 0 && endIndex !== -1) {
        return value.slice(index, endIndex + 1);
      }
    }
  }
  return null;
}

function normalizePayload(payload) {
  const rows = arrayValue(
    payload?.rows ??
      payload?.data ??
      payload?.records ??
      payload?.result ??
      payload?.datasetRows
  );
  const validationIssues = stringArrayValue(
    payload?.validationIssues ?? payload?.issues ?? payload?.errors
  );
  const metrics = payload?.metrics ?? payload?.benchmarkMetrics ?? {};
  const usage = normalizeUsage(payload?.usage ?? metrics.usage ?? metrics);

  return {
    rows,
    validationIssues,
    usage,
    metrics: {
      searchCallCount: numberValue(metrics.searchCallCount ?? metrics.searchCalls),
      fetchCallCount: numberValue(metrics.fetchCallCount ?? metrics.fetchCalls),
      browserCallCount: numberValue(metrics.browserCallCount ?? metrics.browserCalls),
      agentRunCount: numberValue(metrics.agentRunCount ?? metrics.agentRuns),
      agentStepCount: numberValue(metrics.agentStepCount ?? metrics.agentSteps),
    },
  };
}

function normalizeUsage(value) {
  return {
    promptTokens: numberValue(value?.promptTokens ?? value?.inputTokens ?? value?.prompt_tokens),
    completionTokens: numberValue(
      value?.completionTokens ?? value?.outputTokens ?? value?.completion_tokens
    ),
    totalTokens: numberValue(value?.totalTokens ?? value?.total_tokens),
  };
}

function evaluateRows({ rows, promptDefinition }) {
  const missingRequiredCells = [];
  const sourceUrls = new Set();
  const identityKeys = new Set();
  let duplicateIdentityCount = 0;
  let nonEmptyCellCount = 0;
  let evidenceQuoteCount = 0;
  let needsReviewCount = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const cells = rowCells(row);
    const identity = identityKey(cells, row);
    if (identity) {
      if (identityKeys.has(identity)) {
        duplicateIdentityCount += 1;
      }
      identityKeys.add(identity);
    }

    for (const requiredColumn of promptDefinition.requiredColumns) {
      const value = cells[requiredColumn] ?? row?.[requiredColumn];
      if (isPresent(value)) {
        nonEmptyCellCount += 1;
      } else {
        missingRequiredCells.push({ rowIndex, column: requiredColumn });
      }
    }

    for (const url of rowSourceUrls(row, cells)) {
      sourceUrls.add(url);
    }
    evidenceQuoteCount += rowEvidenceQuoteCount(row);
    if (row?.needsReview === true || row?.needs_review === true) {
      needsReviewCount += 1;
    }
  }

  const totalExpectedCellCount = rows.length * promptDefinition.requiredColumns.length;
  const requiredCellCompletenessRatio = totalExpectedCellCount === 0
    ? 0
    : roundRatio(nonEmptyCellCount / totalExpectedCellCount);

  return {
    rowCount: rows.length,
    nonEmptyCellCount,
    totalExpectedCellCount,
    requiredCellCompletenessRatio,
    sourceUrlCount: sourceUrls.size,
    evidenceQuoteCount,
    duplicateIdentityCount,
    missingRequiredCellCount: missingRequiredCells.length,
    missingRequiredCells,
    needsReviewCount,
  };
}

function aggregateResults(results) {
  const groups = new Map();
  for (const result of results) {
    groups.set(result.system, [...(groups.get(result.system) ?? []), result]);
  }

  return Array.from(groups.entries()).map(([system, group]) => {
    const passed = group.filter((result) => result.status === "ok").length;
    const totalLatencyMs = sum(group, "latencyMs");
    const totalEstimatedCostUsd = sum(group, "estimatedTotalCostUsd");
    return {
      system,
      total: group.length,
      passed,
      failed: group.length - passed,
      passRate: roundRatio(passed / Math.max(1, group.length)),
      wallClockMs: totalLatencyMs,
      avgLatencyMs: Math.round(totalLatencyMs / Math.max(1, group.length)),
      avgRequiredCellCompletenessRatio: roundRatio(
        sum(group, "requiredCellCompletenessRatio") / Math.max(1, group.length)
      ),
      totalRows: sum(group, "rowCount"),
      totalEvidenceQuotes: sum(group, "evidenceQuoteCount"),
      totalSourceUrls: sum(group, "sourceUrlCount"),
      totalMissingRequiredCells: sum(group, "missingRequiredCellCount"),
      totalDuplicateIdentities: sum(group, "duplicateIdentityCount"),
      totalPromptTokens: group.reduce((total, result) => total + result.usage.promptTokens, 0),
      totalCompletionTokens: group.reduce((total, result) => total + result.usage.completionTokens, 0),
      totalTokens: group.reduce((total, result) => total + result.usage.totalTokens, 0),
      searchCallCount: sum(group, "searchCallCount"),
      fetchCallCount: sum(group, "fetchCallCount"),
      browserCallCount: sum(group, "browserCallCount"),
      agentRunCount: sum(group, "agentRunCount"),
      agentStepCount: sum(group, "agentStepCount"),
      estimatedTotalCostUsd: roundUsd(totalEstimatedCostUsd),
    };
  });
}

async function writeMarkdownReport(filePath, summary, prompts) {
  const lines = [
    "# Dataset Agent Benchmark Report",
    "",
    `Tested: ${summary.testedAt}`,
    `Completed: ${summary.completedAt}`,
    `Wall clock: ${formatDuration(summary.wallClockMs)}`,
    `Prompt mix: good ${summary.promptMix.good}, average ${summary.promptMix.average}, bad ${summary.promptMix.bad}`,
    "",
    "## Aggregate",
    "",
    "| System | Runs | Passed | Pass Rate | Avg Latency | Rows | Evidence | Sources | Completeness | Missing Required | Duplicates | Tokens In | Tokens Out | Agent Steps | Est Cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.aggregate.map((row) =>
      `| ${escapeMarkdown(row.system)} | ${row.total} | ${row.passed} | ${row.passRate} | ${formatDuration(row.avgLatencyMs)} | ${row.totalRows} | ${row.totalEvidenceQuotes} | ${row.totalSourceUrls} | ${row.avgRequiredCellCompletenessRatio} | ${row.totalMissingRequiredCells} | ${row.totalDuplicateIdentities} | ${row.totalPromptTokens} | ${row.totalCompletionTokens} | ${row.agentStepCount} | ${formatUsd(row.estimatedTotalCostUsd)} |`
    ),
    "",
    "## Prompt Pack",
    "",
    "| # | Quality | Persona | Prompt | Required Columns | Stress |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...prompts.map((prompt, index) =>
      `| ${index + 1} | ${prompt.quality} | ${escapeMarkdown(prompt.persona)} | ${escapeMarkdown(prompt.prompt)} | ${prompt.requiredColumns.join(", ")} | ${escapeMarkdown(prompt.expectedStress)} |`
    ),
    "",
    "## Raw Results",
    "",
    "| System | Prompt | Quality | Status | Latency | Rows | Completeness | Evidence | Sources | Missing Required | Duplicates | Tokens In | Tokens Out | Search | Fetch | Browser | Agent Runs | Agent Steps | Est Cost | Issue |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.laneResults.map((result) =>
      `| ${escapeMarkdown(result.system)} | ${escapeMarkdown(result.promptId)} | ${result.promptQuality} | ${result.status} | ${formatDuration(result.latencyMs)} | ${result.rowCount} | ${result.requiredCellCompletenessRatio} | ${result.evidenceQuoteCount} | ${result.sourceUrlCount} | ${result.missingRequiredCellCount} | ${result.duplicateIdentityCount} | ${result.usage.promptTokens} | ${result.usage.completionTokens} | ${result.searchCallCount} | ${result.fetchCallCount} | ${result.browserCallCount} | ${result.agentRunCount} | ${result.agentStepCount} | ${formatUsd(result.estimatedTotalCostUsd)} | ${escapeMarkdown(result.errorMessage ?? "")} |`
    ),
    "",
  ];
  await writeFile(filePath, `${lines.join("\n")}\n`);
}

function promptMixSummary(prompts) {
  return prompts.reduce(
    (mix, prompt) => {
      mix[prompt.quality] = (mix[prompt.quality] ?? 0) + 1;
      return mix;
    },
    { good: 0, average: 0, bad: 0 }
  );
}

function estimateModelCostUsd(usage, config) {
  return roundUsd(
    (usage.promptTokens / 1_000_000) * config.inputUsdPer1M +
      (usage.completionTokens / 1_000_000) * config.outputUsdPer1M
  );
}

function rowCells(row) {
  if (isRecord(row?.cells)) return row.cells;
  if (isRecord(row?.data)) return row.data;
  return isRecord(row) ? row : {};
}

function rowSourceUrls(row, cells) {
  return [
    ...stringArrayValue(row?.sourceUrls),
    ...stringArrayValue(row?.sources),
    ...stringArrayValue(row?.source_urls),
    ...stringArrayValue(cells?.source_urls),
    ...stringArrayValue(cells?.sources),
    ...singleStringArray(row?.sourceUrl),
    ...singleStringArray(row?.source_url),
    ...singleStringArray(cells?.source_url),
    ...singleStringArray(cells?.sourceUrl),
  ].filter((value) => value.startsWith("http"));
}

function rowEvidenceQuoteCount(row) {
  return arrayValue(row?.evidence).filter((evidence) => {
    if (typeof evidence === "string") return evidence.trim().length > 0;
    return typeof evidence?.quote === "string" && evidence.quote.trim().length > 0;
  }).length;
}

function identityKey(cells, row) {
  const candidates = [
    cells.entity_name,
    cells.company_name,
    cells.product_name,
    cells.bakery_name,
    cells.provider_name,
    cells.name,
    row.id,
  ];
  const identityParts = candidates.filter(isPresent).map((value) =>
    String(value).trim().toLowerCase()
  );
  return identityParts[0] ?? null;
}

function failureReason({ execution, parsedPayload, validation }) {
  if (execution.timedOut) return "Command timed out.";
  if (execution.exitCode !== 0) return `Command exited ${execution.exitCode}.`;
  if (!parsedPayload) return "No parseable JSON object found in stdout.";
  if (validation.rowCount === 0) return "Parsed JSON had zero rows.";
  if (validation.sourceUrlCount === 0) return "No source URLs found.";
  if (validation.evidenceQuoteCount === 0) return "No evidence quotes found.";
  if (validation.requiredCellCompletenessRatio < config.minRequiredCompleteness) {
    return `Required-cell completeness ${validation.requiredCellCompletenessRatio} below ${config.minRequiredCompleteness}.`;
  }
  return "Benchmark failed.";
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function singleStringArray(value) {
  return typeof value === "string" ? [value] : [];
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function sum(items, key) {
  return items.reduce((total, item) => total + numberValue(item[key]), 0);
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatUsd(value) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function roundRatio(value) {
  return Number(value.toFixed(3));
}

function roundUsd(value) {
  return Number(value.toFixed(6));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function printHelpAndExit() {
  console.log(`Usage:
node benchmarks/dataset-agent/run-benchmark.mjs \\
  --system mengzhe='npm run benchmark -- {{promptJson}}' \\
  --system edward='node ./my-agent.js --prompt {{promptJson}}'

Agent command contract:
- stdout should contain a JSON object.
- Preferred shape: { "rows": [], "validationIssues": [], "usage": {}, "metrics": {} }
- usage supports promptTokens/inputTokens, completionTokens/outputTokens, totalTokens.
- metrics supports searchCalls, fetchCalls, browserCalls, agentRuns, agentSteps.
`);
  process.exit(0);
}
