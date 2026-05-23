import { RunStatus, TinyFish, type Run } from "@tiny-fish/sdk";
import { config } from "../config.js";
import { sleep, withRetry } from "../queue/retry.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

let client: TinyFish | null = null;

const TINYFISH_API_BASE = "https://agent.tinyfish.ai";

function getClient(): TinyFish {
  if (!client) {
    client = new TinyFish({ apiKey: config.tinyfishApiKey });
  }
  return client;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
]);

export interface TinyfishAgentRunResult {
  run_id: string | null;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface QueueTinyfishAgentResult {
  run_id: string | null;
  error: string | null;
}

export interface TinyfishAgentJob {
  url: string;
  goal: string;
}

export interface TinyfishAgentRunOptions {
  pollTimeoutMs?: number;
}

function runToResult(run: Run): TinyfishAgentRunResult {
  const errorMessage =
    run.error?.message ??
    (run.status === RunStatus.FAILED ? "Agent run failed" : null);

  return {
    run_id: run.run_id,
    status: run.status,
    result: (run.result as Record<string, unknown> | null) ?? null,
    error: errorMessage,
  };
}

/** Best-effort cancel for async agent runs (POST /v1/runs/{id}/cancel). */
export async function cancelTinyfishAgentRun(runId: string): Promise<void> {
  if (!runId.trim()) return;

  try {
    await withRetry(
      async () => {
        const response = await fetch(
          `${TINYFISH_API_BASE}/v1/runs/${encodeURIComponent(runId)}/cancel`,
          {
            method: "POST",
            headers: {
              "X-API-Key": config.tinyfishApiKey,
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Cancel failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
          );
        }
      },
      {
        maxRetries: 1,
        baseDelayMs: config.retryBaseDelayMs,
        label: `agent.cancel:${runId}`,
      },
    );
  } catch {
    // Cancel is best-effort — polling timeout still reports failure.
  }
}

/** Submit a run via `/run-async` (returns immediately with run_id). */
export async function queueTinyfishAgent(
  url: string,
  goal: string,
): Promise<QueueTinyfishAgentResult> {
  const response = await withRetry(
    () => getClient().agent.queue({ url, goal }),
    {
      maxRetries: config.maxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      label: `agent.queue:${url}`,
    },
  );

  if (response.error) {
    return { run_id: null, error: response.error.message };
  }

  if (!response.run_id) {
    return { run_id: null, error: "Failed to queue agent run (no run_id)" };
  }

  return { run_id: response.run_id, error: null };
}

/** Poll `runs.get` until the run reaches a terminal status or times out. */
export async function pollTinyfishAgentUntilDone(
  runId: string,
  options: TinyfishAgentRunOptions = {},
): Promise<TinyfishAgentRunResult> {
  const startedAt = Date.now();
  const pollTimeoutMs = options.pollTimeoutMs ?? config.agentPollTimeoutMs;
  let lastStatus = RunStatus.PENDING;

  while (true) {
    const run = await withRetry(
      () => getClient().runs.get(runId),
      {
        maxRetries: config.maxRetries,
        baseDelayMs: config.retryBaseDelayMs,
        label: `agent.poll:${runId}`,
      },
    );

    lastStatus = run.status;

    if (TERMINAL_STATUSES.has(run.status)) {
      return runToResult(run);
    }

    if (Date.now() - startedAt >= pollTimeoutMs) {
      await cancelTinyfishAgentRun(runId);

      try {
        const finalRun = await getClient().runs.get(runId);
        if (TERMINAL_STATUSES.has(finalRun.status)) {
          const result = runToResult(finalRun);
          if (finalRun.status === RunStatus.CANCELLED) {
            return {
              ...result,
              error:
                result.error ??
                `Agent run cancelled after ${pollTimeoutMs}ms (was ${lastStatus})`,
            };
          }
          return result;
        }
      } catch {
        // Fall through to TIMEOUT result below.
      }

      return {
        run_id: runId,
        status: "TIMEOUT",
        result: null,
        error: `Agent run timed out after ${pollTimeoutMs}ms (last status: ${lastStatus}); cancel requested`,
      };
    }

    await sleep(config.agentPollIntervalMs);
  }
}

/**
 * Queue then poll — drop-in replacement for the old synchronous `/run` helper.
 */
export async function runTinyfishAgent(
  url: string,
  goal: string,
  options: TinyfishAgentRunOptions = {},
): Promise<TinyfishAgentRunResult> {
  const queued = await queueTinyfishAgent(url, goal);
  if (queued.error || !queued.run_id) {
    return {
      run_id: null,
      status: RunStatus.FAILED,
      result: null,
      error: queued.error ?? "Failed to queue agent run",
    };
  }
  return pollTinyfishAgentUntilDone(queued.run_id, options);
}

/**
 * Queue all jobs quickly, then poll in parallel — better overlap than sync `/run` waves.
 */
export async function runTinyfishAgentsBatch(
  jobs: TinyfishAgentJob[],
  options: TinyfishAgentRunOptions = {},
): Promise<TinyfishAgentRunResult[]> {
  if (jobs.length === 0) return [];

  const queued = await mapWithConcurrency(
    jobs,
    config.agentQueueConcurrency,
    async (job) => {
      const queueResult = await queueTinyfishAgent(job.url, job.goal);
      return { job, ...queueResult };
    },
  );

  const results: TinyfishAgentRunResult[] = new Array(jobs.length);

  const pollTargets: { index: number; run_id: string }[] = [];
  for (let index = 0; index < queued.length; index++) {
    const item = queued[index]!;
    if (item.error || !item.run_id) {
      results[index] = {
        run_id: null,
        status: RunStatus.FAILED,
        result: null,
        error: item.error ?? "Failed to queue agent run",
      };
      continue;
    }
    pollTargets.push({ index, run_id: item.run_id });
  }

  await mapWithConcurrency(
    pollTargets,
    config.agentPollConcurrency,
    async ({ index, run_id }) => {
      results[index] = await pollTinyfishAgentUntilDone(run_id, options);
    },
  );

  return results;
}
