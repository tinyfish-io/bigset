export interface PopulateRuntimeLimits {
  maxRows: number;
  maxSearchCalls: number;
  /** Caps how many scored URLs are passed to the populate agent (env: POPULATE_MAX_FETCH_CALLS). */
  maxFetchCalls: number;
}

const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_SEARCH_CALLS = 50;
const DEFAULT_MAX_FETCH_CALLS = 50;

function readPositiveInt(
  raw: string | undefined,
  fallback: number
): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function resolvePopulateRuntimeLimits(input?: {
  maxRows?: number;
  maxSearchCalls?: number;
  maxFetchCalls?: number;
  env?: NodeJS.ProcessEnv;
}): PopulateRuntimeLimits {
  const env = input?.env ?? process.env;
  const maxRows = input?.maxRows ?? readPositiveInt(env.POPULATE_MAX_ROWS, DEFAULT_MAX_ROWS);
  const maxSearchCalls =
    input?.maxSearchCalls ??
    readPositiveInt(env.POPULATE_MAX_SEARCH_CALLS, DEFAULT_MAX_SEARCH_CALLS);
  const maxFetchCalls =
    input?.maxFetchCalls ??
    readPositiveInt(env.POPULATE_MAX_FETCH_CALLS, DEFAULT_MAX_FETCH_CALLS);

  return {
    maxRows,
    maxSearchCalls,
    maxFetchCalls,
  };
}
