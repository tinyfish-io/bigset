#!/usr/bin/env node
/**
 * Benchmark runner for the BigSet populate workflow.
 *
 * Calls the real populateWorkflow directly (no HTTP layer) using the
 * same code path as production app sessions. Metrics are collected by
 * the instrumented workflow and written to the populateRuns Convex table.
 * After each run the script reads those metrics back and emits a JSON
 * summary.
 *
 * Usage (from repo root):
 *   node --import tsx/esm benchmarks/run.mts [options]
 *
 * Options:
 *   --prompt <id>         Run only the prompt with this id (repeatable)
 *   --prompts <file>      Path to prompts JSON (default: benchmarks/prompts.json)
 *   --out <dir>           Write per-run JSON artifacts to this directory
 *   --no-cleanup          Keep Convex datasets after benchmark (default: delete them)
 *   --concurrency <n>     Max parallel prompt runs (default: 1)
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ─── Load root .env before importing backend modules ────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootEnvPath = join(repoRoot, ".env");

if (existsSync(rootEnvPath)) {
  for (const line of readFileSync(rootEnvPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    let val = trimmed.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] ??= val;
  }
}

// ─── Imports (after env is loaded) ──────────────────────────────────────────

// @ts-ignore — importing from sibling package; resolved at runtime via Node module resolution
import { populateWorkflow } from "../backend/src/mastra/workflows/populate.js";
// @ts-ignore
import { convex, internal } from "../backend/src/convex.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PromptDefinition {
  id: string;
  datasetName: string;
  description: string;
  columns: Array<{
    name: string;
    type: "text" | "number" | "boolean" | "url" | "date";
    description?: string;
  }>;
}

interface RunResult {
  promptId: string;
  datasetName: string;
  workflowRunId: string;
  datasetId: string;
  status: "success" | "error" | "timeout";
  error?: string;
  metrics?: PopulateRunRecord;
  durationMs: number;
}

interface PopulateRunRecord {
  workflowRunId: string;
  datasetId: string;
  userId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  searchCalls: number;
  fetchCalls: number;
  investigateCalls: number;
  rowsInserted: number;
  tokensInput: number;
  tokensOutput: number;
  orchestratorTokensInput: number;
  orchestratorTokensOutput: number;
  orchestratorSteps: number;
  investigateTokensInput: number;
  investigateTokensOutput: number;
  investigateSteps: number;
  investigateRuns: number;
  status: "success" | "error";
  error?: string;
  isBenchmark?: boolean;
}

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const result = {
    promptIds: [] as string[],
    promptsFile: join(dirname(fileURLToPath(import.meta.url)), "prompts.json"),
    outDir: null as string | null,
    cleanup: true,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prompt") result.promptIds.push(argv[++i]);
    else if (arg === "--prompts") result.promptsFile = argv[++i];
    else if (arg === "--out") result.outDir = argv[++i];
    else if (arg === "--no-cleanup") result.cleanup = false;
    else if (arg === "--concurrency") result.concurrency = parseInt(argv[++i], 10);
  }
  return result;
}

// ─── Convex helpers ──────────────────────────────────────────────────────────

async function createBenchmarkDataset(
  name: string,
  description: string,
  columns: PromptDefinition["columns"],
): Promise<string> {
  return await convex.mutation(internal.datasets.createInternal, {
    name,
    description,
    columns,
    ownerId: "benchmark-runner",
    cadence: "manual",
    visibility: "private",
  });
}

async function deleteBenchmarkDataset(datasetId: string): Promise<void> {
  await convex.mutation(internal.datasets.deleteInternal, { id: datasetId });
}

async function fetchRunMetrics(workflowRunId: string): Promise<PopulateRunRecord | null> {
  return await convex.query(internal.populateRuns.getByWorkflowRunId, { workflowRunId });
}

// ─── Run a single prompt ─────────────────────────────────────────────────────

async function runPrompt(
  prompt: PromptDefinition,
  config: ReturnType<typeof parseArgs>,
): Promise<RunResult> {
  const wallStart = Date.now();
  const workflowRunId = `benchmark-${prompt.id}-${randomUUID().slice(0, 8)}`;
  let datasetId = "";

  console.error(`\n[benchmark] ▶ ${prompt.id}`);

  try {
    datasetId = await createBenchmarkDataset(
      `[benchmark] ${prompt.datasetName}`,
      prompt.description,
      prompt.columns,
    );
    console.error(`[benchmark] created dataset ${datasetId}`);

    const run = await populateWorkflow.createRun({ runId: workflowRunId });
    const result = await run.start({
      inputData: {
        datasetId,
        datasetName: prompt.datasetName,
        description: prompt.description,
        columns: prompt.columns,
        authContext: {
          authorizedUserId: "benchmark-runner",
          workflowRunId,
          isBenchmark: true,
        },
      },
    });

    const wallDuration = Date.now() - wallStart;
    if (result.status !== "success") {
      throw new Error(`Workflow ended with status: ${result.status}`);
    }

    // Give the fire-and-forget metrics save a moment to land in Convex
    await sleep(2000);
    const metrics = await fetchRunMetrics(workflowRunId);

    console.error(
      `[benchmark] ✓ ${prompt.id} rows=${metrics?.rowsInserted ?? "?"} ` +
        `tokens=${(metrics?.tokensInput ?? 0) + (metrics?.tokensOutput ?? 0)} ` +
        `duration=${(wallDuration / 1000).toFixed(1)}s`,
    );

    return {
      promptId: prompt.id,
      datasetName: prompt.datasetName,
      workflowRunId,
      datasetId,
      status: "success",
      metrics: metrics ?? undefined,
      durationMs: wallDuration,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[benchmark] ✗ ${prompt.id} error: ${msg}`);

    // Still try to fetch any partial metrics that landed
    await sleep(1000);
    const metrics = await fetchRunMetrics(workflowRunId).catch(() => null);

    return {
      promptId: prompt.id,
      datasetName: prompt.datasetName,
      workflowRunId,
      datasetId,
      status: "error",
      error: msg,
      metrics: metrics ?? undefined,
      durationMs: Date.now() - wallStart,
    };
  } finally {
    if (config.cleanup && datasetId) {
      await deleteBenchmarkDataset(datasetId).catch((err) =>
        console.error(`[benchmark] cleanup failed for ${datasetId}:`, err),
      );
    }
  }
}

// ─── Aggregate summary ───────────────────────────────────────────────────────

function buildSummary(results: RunResult[]) {
  const successful = results.filter((r) => r.status === "success" && r.metrics);
  const failed = results.filter((r) => r.status !== "success");

  const totals = successful.reduce(
    (acc, r) => {
      const m = r.metrics!;
      acc.rowsInserted += m.rowsInserted;
      acc.searchCalls += m.searchCalls;
      acc.fetchCalls += m.fetchCalls;
      acc.investigateCalls += m.investigateCalls;
      acc.tokensInput += m.tokensInput;
      acc.tokensOutput += m.tokensOutput;
      acc.orchestratorSteps += m.orchestratorSteps;
      acc.investigateSteps += m.investigateSteps;
      acc.investigateRuns += m.investigateRuns;
      acc.durationMs += r.durationMs;
      return acc;
    },
    {
      rowsInserted: 0,
      searchCalls: 0,
      fetchCalls: 0,
      investigateCalls: 0,
      tokensInput: 0,
      tokensOutput: 0,
      orchestratorSteps: 0,
      investigateSteps: 0,
      investigateRuns: 0,
      durationMs: 0,
    },
  );

  const n = successful.length || 1;

  return {
    completedAt: new Date().toISOString(),
    promptCount: results.length,
    successCount: successful.length,
    failureCount: failed.length,
    aggregate: totals,
    perRunAverages: {
      rowsInserted: +(totals.rowsInserted / n).toFixed(1),
      searchCalls: +(totals.searchCalls / n).toFixed(1),
      fetchCalls: +(totals.fetchCalls / n).toFixed(1),
      investigateCalls: +(totals.investigateCalls / n).toFixed(1),
      tokensTotal: +((totals.tokensInput + totals.tokensOutput) / n).toFixed(0),
      durationSeconds: +((totals.durationMs / n / 1000).toFixed(1)),
    },
    runs: results.map((r) => ({
      promptId: r.promptId,
      datasetName: r.datasetName,
      workflowRunId: r.workflowRunId,
      status: r.status,
      error: r.error,
      durationMs: r.durationMs,
      metrics: r.metrics
        ? {
            rowsInserted: r.metrics.rowsInserted,
            searchCalls: r.metrics.searchCalls,
            fetchCalls: r.metrics.fetchCalls,
            investigateCalls: r.metrics.investigateCalls,
            tokensInput: r.metrics.tokensInput,
            tokensOutput: r.metrics.tokensOutput,
            orchestratorTokensInput: r.metrics.orchestratorTokensInput,
            orchestratorTokensOutput: r.metrics.orchestratorTokensOutput,
            orchestratorSteps: r.metrics.orchestratorSteps,
            investigateTokensInput: r.metrics.investigateTokensInput,
            investigateTokensOutput: r.metrics.investigateTokensOutput,
            investigateSteps: r.metrics.investigateSteps,
            investigateRuns: r.metrics.investigateRuns,
          }
        : null,
    })),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs(process.argv.slice(2));

  // Validate required env vars
  const missing = ["OPENROUTER_API_KEY", "TINYFISH_API_KEY", "CONVEX_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    console.error(`[benchmark] Missing required env vars: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in the values, then re-run.");
    process.exit(1);
  }

  const allPrompts: PromptDefinition[] = JSON.parse(
    await readFile(config.promptsFile, "utf8"),
  );
  const prompts =
    config.promptIds.length > 0
      ? allPrompts.filter((p) => config.promptIds.includes(p.id))
      : allPrompts;

  if (prompts.length === 0) {
    console.error(`[benchmark] No matching prompts found.`);
    process.exit(1);
  }

  console.error(`[benchmark] Running ${prompts.length} prompt(s) (concurrency=${config.concurrency})`);

  const results: RunResult[] = [];

  // Run in batches of config.concurrency
  for (let i = 0; i < prompts.length; i += config.concurrency) {
    const batch = prompts.slice(i, i + config.concurrency);
    const batchResults = await Promise.all(batch.map((p) => runPrompt(p, config)));
    results.push(...batchResults);
  }

  const summary = buildSummary(results);

  if (config.outDir) {
    await mkdir(config.outDir, { recursive: true });
    const outFile = join(config.outDir, `benchmark-${Date.now()}.json`);
    await writeFile(outFile, JSON.stringify(summary, null, 2));
    console.error(`[benchmark] Results written to ${outFile}`);
  }

  // Emit JSON to stdout for piping / CI capture
  console.log(JSON.stringify(summary, null, 2));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[benchmark] Fatal:", err);
  process.exit(1);
});
