import { FetchFormat, RunStatus, TinyFish } from "@tiny-fish/sdk";
import type {
  AgentRunResponse,
  FetchResult,
  Run,
  SearchResult,
} from "@tiny-fish/sdk";

import type {
  DatasetAgentBrowserResult,
  DatasetAgentFetchedPage,
  DatasetAgentSearchResult,
  DatasetAgentToolProvider,
} from "./types.js";

const TINYFISH_FETCH_BATCH_SIZE = 10;
const DEFAULT_AGENT_DEADLINE_MS = 120_000;
const DEFAULT_AGENT_POLL_INTERVAL_MS = 2_500;

export function createTinyFishToolProvider(config: {
  apiKey?: string;
  timeoutMs?: number;
}): DatasetAgentToolProvider | undefined {
  if (!config.apiKey) {
    return undefined;
  }
  return new TinyFishToolProvider({
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
}

class TinyFishToolProvider implements DatasetAgentToolProvider {
  private readonly sdk: TinyFish;

  constructor(config: { apiKey: string; timeoutMs?: number }) {
    this.sdk = new TinyFish({
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  async search(input: { query: string }): Promise<DatasetAgentSearchResult[]> {
    const response = await this.sdk.search.query({ query: input.query });
    return response.results.map(normalizeSearchResult);
  }

  async fetch(input: { urls: string[] }): Promise<DatasetAgentFetchedPage[]> {
    const uniqueUrls = Array.from(new Set(input.urls.filter(Boolean)));
    const pages: DatasetAgentFetchedPage[] = [];

    for (let startIndex = 0; startIndex < uniqueUrls.length; startIndex += TINYFISH_FETCH_BATCH_SIZE) {
      const urlBatch = uniqueUrls.slice(
        startIndex,
        startIndex + TINYFISH_FETCH_BATCH_SIZE
      );
      const response = await this.sdk.fetch.getContents({
        urls: urlBatch,
        format: FetchFormat.Markdown,
        links: true,
        image_links: false,
      });
      pages.push(...response.results.map(normalizeFetchedPage));
    }

    return pages;
  }

  async browser(input: {
    url: string;
    goal: string;
  }): Promise<DatasetAgentBrowserResult> {
    const queuedRun = await this.sdk.agent.queue({
      url: input.url,
      goal: input.goal,
    });

    if (queuedRun.error || !queuedRun.run_id) {
      return {
        url: input.url,
        status: "failed",
        payload: null,
        errorMessage: stringifyTinyFishError(
          queuedRun.error ?? "TinyFish Agent queue returned no run id."
        ),
      };
    }

    const deadlineAt = Date.now() + DEFAULT_AGENT_DEADLINE_MS;
    while (Date.now() < deadlineAt) {
      const run = normalizeRun(await this.sdk.runs.get(queuedRun.run_id), input.url);
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        return run;
      }
      await sleep(DEFAULT_AGENT_POLL_INTERVAL_MS);
    }

    return {
      url: input.url,
      status: "running",
      payload: null,
      errorMessage: "TinyFish Agent run exceeded backend deadline.",
    };
  }
}

function normalizeSearchResult(result: SearchResult): DatasetAgentSearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    position: result.position,
  };
}

function normalizeFetchedPage(result: FetchResult): DatasetAgentFetchedPage {
  const text =
    typeof result.text === "string"
      ? result.text
      : result.text
        ? JSON.stringify(result.text)
        : null;

  return {
    url: result.url,
    finalUrl: result.final_url,
    title: result.title,
    text,
  };
}

function normalizeRun(
  run: Run | AgentRunResponse,
  url: string
): DatasetAgentBrowserResult {
  return {
    url,
    status: tinyFishRunStatus(run.status),
    payload: isRecord(run.result) ? run.result : null,
    errorMessage: "error" in run ? stringifyTinyFishError(run.error) : null,
    stepCount: getTinyFishStepCount(run),
  };
}

function getTinyFishStepCount(run: Run | AgentRunResponse): number | null {
  if ("num_of_steps" in run) {
    return numberOrNull(run.num_of_steps);
  }
  return null;
}

function tinyFishRunStatus(
  status: RunStatus | string | undefined
): DatasetAgentBrowserResult["status"] {
  if (status === RunStatus.COMPLETED || status === "completed") {
    return "completed";
  }
  if (status === RunStatus.FAILED || status === "failed") {
    return "failed";
  }
  if (status === RunStatus.CANCELLED || status === "cancelled") {
    return "cancelled";
  }
  if (status === RunStatus.RUNNING || status === "running") {
    return "running";
  }
  return "pending";
}

function stringifyTinyFishError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
