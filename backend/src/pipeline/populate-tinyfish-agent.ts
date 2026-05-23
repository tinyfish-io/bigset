import { RunStatus, TinyFish } from "@tiny-fish/sdk";

import type {
  BrowserAgentJob,
  BrowserAgentRunResult,
} from "./populate-browser-agent.js";
import type { PopulateExtractionSpec } from "./populate-extraction-spec.js";
import type { PopulateSourceTriageResult } from "./types.js";
import {
  resolvePopulateTinyfishAgentConfig,
  type PopulateTinyfishAgentConfig,
} from "./populate-parallel-config.js";

export type TinyfishAgentRunResult = BrowserAgentRunResult;
export type TinyfishAgentJob = BrowserAgentJob;

let client: TinyFish | null = null;

function getClient(apiKey: string): TinyFish {
  if (!client) {
    client = new TinyFish({ apiKey });
  }
  return client;
}

function requiredTinyfishApiKey(): string {
  const apiKey = process.env.TINYFISH_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing required environment variable: TINYFISH_API_KEY");
  }
  return apiKey;
}

export function buildTinyfishAgentGoal(input: {
  userPrompt: string;
  spec: PopulateExtractionSpec;
  triage: PopulateSourceTriageResult;
}): string {
  const columnHints = input.spec.columns
    .map((column) => `${column.name}: ${column.description}`)
    .join("; ");
  const action =
    input.triage.suggested_action?.trim() ||
    "navigate the page and extract the requested fields";
  return `Goal: ${input.userPrompt}. Make sure to gather data for ${columnHints}. You may ${action}.`;
}

export function agentPriorityScore(triage: PopulateSourceTriageResult): number {
  const yieldScore =
    triage.expected_yield === "complete"
      ? 1
      : triage.expected_yield === "partial"
        ? 0.5
        : 0;
  return (triage.source_data_confidence + yieldScore) / 2;
}

async function pollUntilDone(
  runId: string,
  config: PopulateTinyfishAgentConfig
): Promise<TinyfishAgentRunResult> {
  const apiKey = requiredTinyfishApiKey();
  const startedAt = Date.now();
  let lastStatus = RunStatus.PENDING;

  while (true) {
    const run = await getClient(apiKey).runs.get(runId);
    lastStatus = run.status;
    if (
      run.status === RunStatus.COMPLETED ||
      run.status === RunStatus.FAILED ||
      run.status === RunStatus.CANCELLED
    ) {
      return {
        run_id: run.run_id,
        status: run.status,
        result: (run.result as Record<string, unknown> | null) ?? null,
        error: run.error?.message ?? null,
      };
    }
    if (Date.now() - startedAt >= config.pollTimeoutMs) {
      return {
        run_id: runId,
        status: "TIMEOUT",
        result: null,
        error: `Agent run timed out after ${config.pollTimeoutMs}ms (last status: ${lastStatus})`,
      };
    }
    await sleep(config.pollIntervalMs);
  }
}

export async function runTinyfishAgent(
  job: TinyfishAgentJob,
  config: PopulateTinyfishAgentConfig = resolvePopulateTinyfishAgentConfig()
): Promise<TinyfishAgentRunResult> {
  const apiKey = requiredTinyfishApiKey();
  const queued = await getClient(apiKey).agent.queue({
    url: job.url,
    goal: job.goal,
  });
  if (queued.error || !queued.run_id) {
    return {
      run_id: null,
      status: RunStatus.FAILED,
      result: null,
      error: queued.error?.message ?? "Failed to queue Tinyfish agent run",
    };
  }
  return pollUntilDone(queued.run_id, config);
}

export async function runTinyfishAgentsBatch(
  jobs: TinyfishAgentJob[],
  config: PopulateTinyfishAgentConfig = resolvePopulateTinyfishAgentConfig()
): Promise<TinyfishAgentRunResult[]> {
  if (jobs.length === 0) {
    return [];
  }
  return Promise.all(jobs.map((job) => runTinyfishAgent(job, config)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
