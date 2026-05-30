import { convex, internal } from "../convex.js";
import type { RunMetrics } from "./run-metrics.js";

export interface SaveRunMetricsInput {
  workflowRunId: string;
  datasetId: string;
  userId: string;
  startedAt: number;
  finishedAt: number;
  metrics: RunMetrics;
  status: "success" | "error";
  error?: string;
  isBenchmark?: boolean;
  workflowType?: "populate" | "update";
}

/**
 * Persist a completed run's metrics to the runStats Convex table.
 *
 * Called from the agentStep finally-block as a fire-and-forget operation —
 * any error here is logged but must never propagate to the populate workflow.
 */
export async function saveRunMetrics(input: SaveRunMetricsInput): Promise<void> {
  const totals = input.metrics.totals();
  await convex.mutation(internal.runStats.insert, {
    workflowRunId: input.workflowRunId,
    datasetId: input.datasetId,
    userId: input.userId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.finishedAt - input.startedAt,

    searchCalls: input.metrics.searchCalls,
    fetchCalls: input.metrics.fetchCalls,
    investigateCalls: input.metrics.investigateCalls,
    rowsInserted: input.metrics.rowsInserted,

    tokensInput: totals.inputTokens,
    tokensOutput: totals.outputTokens,

    orchestratorTokensInput: input.metrics.orchestrator.inputTokens,
    orchestratorTokensOutput: input.metrics.orchestrator.outputTokens,
    orchestratorSteps: input.metrics.orchestrator.steps,
    investigateTokensInput: input.metrics.investigate.inputTokens,
    investigateTokensOutput: input.metrics.investigate.outputTokens,
    investigateSteps: input.metrics.investigate.steps,
    investigateRuns: input.metrics.investigate.runs,

    status: input.status,
    error: input.error,
    isBenchmark: input.isBenchmark,
    workflowType: input.workflowType,
    rowsUpdated: input.metrics.rowsUpdated > 0 ? input.metrics.rowsUpdated : undefined,
  });
}
