/**
 * Shared contract for browser agents (Tinyfish + optional Playwright).
 * Edward's Playwright agent should accept the same job shape and return this result.
 */

export interface BrowserAgentJob {
  url: string;
  goal: string;
}

export interface BrowserAgentRunResult {
  run_id: string | null;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** Extra inputs Playwright can use when replaying a prior Tinyfish visit from memory. */
export interface PlaywrightAgentJob extends BrowserAgentJob {
  emitted_process?: Record<string, unknown> | null;
  prior_tinyfish_run_id?: string | null;
  repair_loop?: number;
}

/** Normalize Tinyfish (or Playwright) payloads into memory-friendly process snapshots. */
export function extractEmittedProcessFromAgentResult(
  result: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }

  const candidates = [
    result.emitted_process,
    result.process,
    result.steps,
    result.actions,
    result.navigation_trace,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
    if (Array.isArray(candidate) && candidate.length > 0) {
      return { steps: candidate };
    }
  }

  return result;
}
