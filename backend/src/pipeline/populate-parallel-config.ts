const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return TRUTHY.has(raw.trim().toLowerCase());
}

export interface PopulateParallelConfig {
  urlsPerWorker: number;
  maxTinyfishAgentRuns: number;
  enableTinyfishAgent: boolean;
  maxPlaywrightAgentRuns: number;
  enablePlaywrightAgent: boolean;
}

export interface PopulatePlaywrightAgentConfig {
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

export interface PopulateTinyfishAgentConfig {
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

const DEFAULT_URLS_PER_WORKER = 5;
const DEFAULT_MAX_TINYFISH_AGENT_RUNS = 5;
const DEFAULT_ENABLE_TINYFISH_AGENT = true;
const DEFAULT_MAX_PLAYWRIGHT_AGENT_RUNS = 10;
const DEFAULT_ENABLE_PLAYWRIGHT_AGENT = false;
const DEFAULT_AGENT_POLL_TIMEOUT_MS = 480_000;
const DEFAULT_AGENT_POLL_INTERVAL_MS = 3_000;

export function resolvePopulateParallelConfig(
  env: NodeJS.ProcessEnv = process.env
): PopulateParallelConfig {
  return {
    urlsPerWorker: readPositiveInt(
      env.POPULATE_URLS_PER_WORKER,
      DEFAULT_URLS_PER_WORKER
    ),
    maxTinyfishAgentRuns: readPositiveInt(
      env.POPULATE_MAX_TINYFISH_AGENT_RUNS,
      DEFAULT_MAX_TINYFISH_AGENT_RUNS
    ),
    enableTinyfishAgent: readBoolean(
      env.POPULATE_ENABLE_TINYFISH_AGENT,
      DEFAULT_ENABLE_TINYFISH_AGENT
    ),
    maxPlaywrightAgentRuns: readPositiveInt(
      env.POPULATE_MAX_PLAYWRIGHT_AGENT_RUNS,
      DEFAULT_MAX_PLAYWRIGHT_AGENT_RUNS
    ),
    enablePlaywrightAgent: readBoolean(
      env.POPULATE_ENABLE_PLAYWRIGHT_AGENT,
      DEFAULT_ENABLE_PLAYWRIGHT_AGENT
    ),
  };
}

export function resolvePopulatePlaywrightAgentConfig(
  env: NodeJS.ProcessEnv = process.env
): PopulatePlaywrightAgentConfig {
  return {
    pollTimeoutMs: readPositiveInt(
      env.POPULATE_PLAYWRIGHT_AGENT_POLL_TIMEOUT_MS,
      DEFAULT_AGENT_POLL_TIMEOUT_MS
    ),
    pollIntervalMs: readPositiveInt(
      env.POPULATE_PLAYWRIGHT_AGENT_POLL_INTERVAL_MS,
      DEFAULT_AGENT_POLL_INTERVAL_MS
    ),
  };
}

export function resolvePopulateTinyfishAgentConfig(
  env: NodeJS.ProcessEnv = process.env
): PopulateTinyfishAgentConfig {
  return {
    pollTimeoutMs: readPositiveInt(
      env.POPULATE_TINYFISH_AGENT_POLL_TIMEOUT_MS,
      DEFAULT_AGENT_POLL_TIMEOUT_MS
    ),
    pollIntervalMs: readPositiveInt(
      env.POPULATE_TINYFISH_AGENT_POLL_INTERVAL_MS,
      DEFAULT_AGENT_POLL_INTERVAL_MS
    ),
  };
}
