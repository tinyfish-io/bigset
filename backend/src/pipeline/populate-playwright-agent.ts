import type { BrowserAgentRunResult, PlaywrightAgentJob } from "./populate-browser-agent.js";

export type { PlaywrightAgentJob } from "./populate-browser-agent.js";
import {
  resolvePopulatePlaywrightAgentConfig,
  type PopulatePlaywrightAgentConfig,
} from "./populate-parallel-config.js";

/**
 * Black-box dock for Edward's Playwright agent.
 *
 * Replace the body of `runPlaywrightAgent` (or inject `runPlaywrightAgentsBatch` via
 * `PopulateParallelHooks`) with a call into your script runner. Input/output must match
 * Tinyfish: `{ url, goal }` in, `{ run_id, status, result, error }` out.
 *
 * When `emitted_process` is set on the job, use it as the replay blueprint from
 * `PopulateCollectionMemory.agent_visited_urls` (see docs/playwright-agent-integration.md).
 */
export async function runPlaywrightAgent(
  job: PlaywrightAgentJob,
  _config: PopulatePlaywrightAgentConfig = resolvePopulatePlaywrightAgentConfig()
): Promise<BrowserAgentRunResult> {
  void job;
  return {
    run_id: null,
    status: "NOT_IMPLEMENTED",
    result: null,
    error:
      "Playwright agent is not implemented. Implement runPlaywrightAgent in populate-playwright-agent.ts " +
      "or pass runPlaywrightAgentsBatch through PopulateParallelHooks.",
  };
}

export async function runPlaywrightAgentsBatch(
  jobs: PlaywrightAgentJob[],
  config?: PopulatePlaywrightAgentConfig
): Promise<BrowserAgentRunResult[]> {
  if (jobs.length === 0) {
    return [];
  }
  return Promise.all(jobs.map((job) => runPlaywrightAgent(job, config)));
}
