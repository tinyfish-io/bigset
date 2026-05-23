import "dotenv/config";

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${name}: expected number 0–1, got "${raw}"`);
  }
  return value;
}

function readOptionalFloat(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value) || value < 0 || value > 2) {
    throw new Error(`Invalid ${name}: expected number 0–2, got "${raw}"`);
  }
  return value;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected positive integer, got "${raw}"`);
  }
  return value;
}

const maxPageChars = readInt("MAX_PAGE_CHARS", 12000);
const triageExtractMaxPageChars = process.env.TRIAGE_EXTRACT_MAX_PAGE_CHARS
  ? readInt("TRIAGE_EXTRACT_MAX_PAGE_CHARS", maxPageChars * 2)
  : maxPageChars * 2;

export const config = {
  tinyfishApiKey: process.env.TINYFISH_API_KEY ?? "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite",
  openRouterSiteUrl:
    process.env.OPENROUTER_SITE_URL ??
    "https://github.com/MMeteorL/BigSet_Data_Collection_Agent",
  openRouterAppName:
    process.env.OPENROUTER_APP_NAME ?? "BigSet Data Collection Agent",
  /** Omit temperature by default — Gemini/reasoning models on OpenRouter reject it. Set OPENROUTER_TEMPERATURE to override. */
  openRouterTemperature: readOptionalFloat("OPENROUTER_TEMPERATURE"),
  maxSearchQueries: readInt("MAX_SEARCH_QUERIES", 6),
  maxResultsPerQuery: readInt("MAX_RESULTS_PER_QUERY", 5),
  maxUrlsToFetch: readInt("MAX_URLS_TO_FETCH", 20),
  maxPageChars,
  /** v1.5.2: combined triage+extract agent page budget (default 2× maxPageChars). */
  triageExtractMaxPageChars,
  /** v1.5.2: one LLM call for triage + inline extract (default). Set false for v1.4 two-call path. */
  enableCombinedTriageExtract: readBool("ENABLE_COMBINED_TRIAGE_EXTRACT", true),
  extractionConcurrency: readInt("EXTRACTION_CONCURRENCY", 5),
  fetchBatchSize: readInt("FETCH_BATCH_SIZE", 10),
  fetchConcurrency: readInt("FETCH_CONCURRENCY", 4),
  searchConcurrency: readInt("SEARCH_CONCURRENCY", 4),
  maxConcurrentPerDomain: readInt("MAX_CONCURRENT_PER_DOMAIN", 2),
  maxRetries: readInt("MAX_RETRIES", 2),
  retryBaseDelayMs: readInt("RETRY_BASE_DELAY_MS", 1000),
  openRouterRpm: readInt("OPENROUTER_RPM", 60),
  tinyfishSearchRpm: readInt("TINYFISH_SEARCH_RPM", 30),
  tinyfishFetchRpm: readInt("TINYFISH_FETCH_RPM", 30),
  tinyfishAgentRpm: readInt("TINYFISH_AGENT_RPM", 10),
  enableRepairLoop: readBool("ENABLE_REPAIR_LOOP", true),
  maxRepairLoops: readInt("MAX_REPAIR_LOOPS", 3),
  enableWorkflowMemory: readBool("ENABLE_WORKFLOW_MEMORY", true),
  maxRepairQueries: readInt("MAX_REPAIR_QUERIES", 4),
  maxRepairResultsPerQuery: readInt("MAX_REPAIR_RESULTS_PER_QUERY", 5),
  maxRepairUrlsToFetch: readInt("MAX_REPAIR_URLS_TO_FETCH", 10),
  /** Top historical queries to re-run on the next Search API page during repair. */
  maxRepairSearchPaginationQueries: readInt(
    "MAX_REPAIR_SEARCH_PAGINATION_QUERIES",
    2,
  ),
  /** Highest Search API page index (API allows 0–10). */
  maxSearchPage: readInt("MAX_SEARCH_PAGE", 10),
  enableRepairLinkFollow: readBool("ENABLE_REPAIR_LINK_FOLLOW", true),
  maxRepairLinkUrls: readInt("MAX_REPAIR_LINK_URLS", 8),
  maxLinksPerSourcePage: readInt("MAX_LINKS_PER_SOURCE_PAGE", 3),
  enableTriage: readBool("ENABLE_TRIAGE", true),
  enableTinyfishAgent: readBool("ENABLE_TINYFISH_AGENT", true),
  maxAgentRunsPerPhase: readInt("MAX_AGENT_RUNS_PER_PHASE", 5),
  agentConcurrency: readInt("AGENT_CONCURRENCY", 2),
  /** Parallel `/run-async` queue submissions per agent phase. */
  agentQueueConcurrency: readInt("AGENT_QUEUE_CONCURRENCY", 10),
  /** Parallel `runs.get` polls while agent jobs execute on Tinyfish. */
  agentPollConcurrency: readInt("AGENT_POLL_CONCURRENCY", 10),
  agentPollIntervalMs: readInt("AGENT_POLL_INTERVAL_MS", 3000),
  agentPollTimeoutMs: readInt("AGENT_POLL_TIMEOUT_MS", 1_200_000),
  /** v1.5.2: more parallel combined agents (fewer pages per worker). */
  triageConcurrency: readInt("TRIAGE_CONCURRENCY", 10),
  enableQualityScoring: readBool("ENABLE_QUALITY_SCORING", true),
  /** results.csv only includes rows with all required fields, ranked by quality. */
  enableSelectiveResults: readBool("ENABLE_SELECTIVE_RESULTS", true),
  qualityLowConfidenceThreshold: readFloat("QUALITY_LOW_CONFIDENCE_THRESHOLD", 0.55),
  qualityReviewThreshold: readFloat("QUALITY_REVIEW_THRESHOLD", 0.75),
  qualitySourceConfidenceThreshold: readFloat(
    "QUALITY_SOURCE_CONFIDENCE_THRESHOLD",
    0.5,
  ),
  qualityExtractionConfidenceThreshold: readFloat(
    "QUALITY_EXTRACTION_CONFIDENCE_THRESHOLD",
    0.6,
  ),
} as const;

export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.tinyfishApiKey) missing.push("TINYFISH_API_KEY");
  if (!config.openRouterApiKey) missing.push("OPENROUTER_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill in values.`,
    );
  }
}
