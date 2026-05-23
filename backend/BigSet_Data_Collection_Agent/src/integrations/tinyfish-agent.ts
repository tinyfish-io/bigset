import { RunStatus, TinyFish, type Run } from "@tiny-fish/sdk";
import { config } from "../config.js";
import type { BrowserActionReport } from "../models/schemas.js";
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
  agent_step_count: number | null;
  has_streaming_url: boolean;
  has_recording_url: boolean;
  capture_artifact_count: number;
  result_keys: string[];
  browser_actions: BrowserActionReport[];
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

type TinyfishRunWithTrace = Run & {
  steps?: unknown;
  recording_url?: unknown;
  recordingUrl?: unknown;
  captures?: unknown;
  capture_artifacts?: unknown;
  captureArtifacts?: unknown;
  artifacts?: unknown;
};

export function tinyfishAgentRunResultFromRun(run: Run): TinyfishAgentRunResult {
  const errorMessage =
    run.error?.message ??
    (run.status === RunStatus.FAILED ? "Agent run failed" : null);
  const result = (run.result as Record<string, unknown> | null) ?? null;
  const runWithTrace = run as TinyfishRunWithTrace;

  return {
    run_id: run.run_id,
    status: run.status,
    result,
    error: errorMessage,
    agent_step_count: typeof run.num_of_steps === "number"
      ? run.num_of_steps
      : null,
    has_streaming_url: typeof run.streaming_url === "string" &&
      run.streaming_url.length > 0,
    has_recording_url: hasNonEmptyString(
      runWithTrace.recording_url ?? runWithTrace.recordingUrl
    ),
    capture_artifact_count: countCaptureArtifacts(runWithTrace),
    result_keys: result ? Object.keys(result).sort() : [],
    browser_actions: browserActionsFromRunSteps(runWithTrace),
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
      return tinyfishAgentRunResultFromRun(run);
    }

    if (Date.now() - startedAt >= pollTimeoutMs) {
      await cancelTinyfishAgentRun(runId);

      try {
        const finalRun = await getClient().runs.get(runId);
        if (TERMINAL_STATUSES.has(finalRun.status)) {
          const result = tinyfishAgentRunResultFromRun(finalRun);
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
        agent_step_count: null,
        has_streaming_url: false,
        has_recording_url: false,
        capture_artifact_count: 0,
        result_keys: [],
        browser_actions: [],
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
      agent_step_count: null,
      has_streaming_url: false,
      has_recording_url: false,
      capture_artifact_count: 0,
      result_keys: [],
      browser_actions: [],
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
        agent_step_count: null,
        has_streaming_url: false,
        has_recording_url: false,
        capture_artifact_count: 0,
        result_keys: [],
        browser_actions: [],
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

function browserActionsFromRunSteps(run: TinyfishRunWithTrace): BrowserActionReport[] {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const actions = steps
    .map((step) => browserActionFromRunStep(step))
    .filter((action): action is BrowserActionReport => Boolean(action));
  return dedupeBrowserActions(actions);
}

function browserActionFromRunStep(step: unknown): BrowserActionReport | undefined {
  if (!isRecord(step)) {
    return undefined;
  }

  const action = normalizeBrowserAction(
    firstStringAtPaths(step, [
      ["action"],
      ["type"],
      ["kind"],
      ["operation"],
      ["tool"],
      ["name"],
      ["event"],
    ])
  );
  const url = firstStringAtPaths(step, [
    ["url"],
    ["current_url"],
    ["currentUrl"],
    ["target_url"],
    ["targetUrl"],
    ["page_url"],
    ["pageUrl"],
    ["href"],
    ["input", "url"],
    ["args", "url"],
    ["arguments", "url"],
    ["target", "url"],
    ["metadata", "url"],
  ]);
  const selector = firstStringAtPaths(step, [
    ["selector"],
    ["locator"],
    ["target", "selector"],
    ["element", "selector"],
    ["input", "selector"],
    ["args", "selector"],
    ["arguments", "selector"],
  ]);
  const targetText = targetTextFromStep(step, action);
  const status = normalizeStepStatus(
    firstStringAtPaths(step, [
      ["status"],
      ["state"],
      ["outcome"],
      ["result", "status"],
    ])
  );
  const error = errorMessageFromStep(step);
  const phase = firstStringAtPaths(step, [["phase"], ["stage"]]) ?? "agent-step";
  const label = firstStringAtPaths(step, [
    ["label"],
    ["description"],
    ["summary"],
    ["name"],
    ["type"],
  ]);
  const valueDescription = valueDescriptionFromStep(step, action);

  const report: BrowserActionReport = {
    action,
    url,
    selector,
    target_text: targetText,
    status: status ?? (error ? "failed" : undefined),
    error,
    phase,
    label,
    value_description: valueDescription,
  };

  return hasReplayAnchor(report) ? report : undefined;
}

function normalizeBrowserAction(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (/\b(click|tap|press|select)\b/.test(lower)) return "click";
  if (/\b(navigate|goto|go_to|open|visit)\b/.test(lower)) return "navigate";
  if (/\b(fill|type|input|enter_text|set_value)\b/.test(lower)) return "type";
  if (/\b(scroll)\b/.test(lower)) return "scroll";
  if (/\b(wait)\b/.test(lower)) return "wait";
  if (/\b(extract|scrape|read)\b/.test(lower)) return "extract";
  return value.slice(0, 80);
}

function normalizeStepStatus(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (/\b(success|succeeded|completed|complete|done|ok)\b/.test(lower)) {
    return "succeeded";
  }
  if (/\b(failed|failure|error)\b/.test(lower)) {
    return "failed";
  }
  if (/\b(cancelled|canceled)\b/.test(lower)) {
    return "cancelled";
  }
  return value.slice(0, 80);
}

function targetTextFromStep(
  step: Record<string, unknown>,
  action: string | undefined
): string | undefined {
  const explicitTargetText = firstStringAtPaths(step, [
    ["target_text"],
    ["targetText"],
    ["target", "text"],
    ["element", "text"],
    ["input", "target_text"],
    ["args", "target_text"],
    ["arguments", "target_text"],
  ]);
  if (explicitTargetText) {
    return explicitTargetText;
  }
  if (action === "fill") {
    return firstStringAtPaths(step, [
      ["placeholder"],
      ["label"],
      ["target", "label"],
      ["element", "label"],
      ["input", "label"],
      ["args", "label"],
      ["arguments", "label"],
    ]);
  }
  return firstStringAtPaths(step, [
    ["text"],
    ["label"],
    ["target", "label"],
    ["element", "label"],
  ]);
}

function valueDescriptionFromStep(
  step: Record<string, unknown>,
  action: string | undefined
): string | undefined {
  if (action !== "type") {
    return firstStringAtPaths(step, [
      ["value_description"],
      ["valueDescription"],
    ]);
  }

  const explicitDescription = firstStringAtPaths(step, [
    ["value_description"],
    ["valueDescription"],
  ]);
  if (explicitDescription) {
    return explicitDescription;
  }

  const typedValue = firstStringAtPaths(step, [
    ["value"],
    ["text"],
    ["input", "value"],
    ["args", "value"],
    ["arguments", "value"],
  ]);
  return typedValue
    ? `redacted typed value (${typedValue.length} chars)`
    : "redacted typed value";
}

function errorMessageFromStep(step: Record<string, unknown>): string | undefined {
  const errorValue = valueAtFirstPath(step, [
    ["error"],
    ["failure"],
    ["failure_reason"],
    ["failureReason"],
    ["result", "error"],
  ]);
  if (typeof errorValue === "string") {
    return errorValue.slice(0, 200);
  }
  if (isRecord(errorValue) && typeof errorValue.message === "string") {
    return errorValue.message.slice(0, 200);
  }
  return undefined;
}

function countCaptureArtifacts(run: TinyfishRunWithTrace): number {
  const artifactValues = [
    run.captures,
    run.capture_artifacts,
    run.captureArtifacts,
    run.artifacts,
  ];
  return artifactValues.reduce((count, value) => {
    if (Array.isArray(value)) {
      return count + value.length;
    }
    if (isRecord(value)) {
      return count + Object.keys(value).length;
    }
    return count;
  }, 0);
}

function firstStringAtPaths(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[]
): string | undefined {
  for (const path of paths) {
    const value = valueAtPath(record, path);
    if (hasNonEmptyString(value)) {
      return value.trim().slice(0, 500);
    }
  }
  return undefined;
}

function valueAtFirstPath(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[]
): unknown {
  for (const path of paths) {
    const value = valueAtPath(record, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function valueAtPath(
  record: Record<string, unknown>,
  path: readonly string[]
): unknown {
  let value: unknown = record;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

function hasReplayAnchor(action: BrowserActionReport): boolean {
  return Boolean(action.url || action.selector || action.target_text || action.targetText);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dedupeBrowserActions(
  actions: BrowserActionReport[]
): BrowserActionReport[] {
  const seen = new Set<string>();
  const deduped: BrowserActionReport[] = [];
  for (const action of actions) {
    const key = JSON.stringify([
      action.action ?? "",
      action.url ?? "",
      action.selector ?? "",
      action.target_text ?? action.targetText ?? "",
      action.status ?? "",
      action.error ?? "",
      action.phase ?? "",
      action.label ?? "",
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }
  return deduped;
}
