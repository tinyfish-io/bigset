import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  datasetAbortError,
  getSignal,
  isAbortLikeError,
  throwIfDatasetRunAborted,
} from "../../abort-registry.js";
import { FETCH_TIMEOUT_MS } from "../../fetch-timeout.js";
import { getTinyFishApiKey, tinyFishHeaders } from "../../local-credentials.js";

const searchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
});

const FETCH_FAILURE_CACHE_TTL_MS = 10 * 60 * 1000;
const recentFetchFailures = new Map<
  string,
  { at: number; code: string; status?: string; message: string }
>();

interface WebToolOptions {
  datasetId?: string;
}

function timeoutSignalForDataset(datasetId: string | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  if (datasetId) throwIfDatasetRunAborted(datasetId);

  const controller = new AbortController();
  const runSignal = datasetId ? getSignal(datasetId) : undefined;
  let timedOut = false;

  const abortForRunStop = () => {
    controller.abort(runSignal?.reason ?? datasetAbortError());
  };
  if (runSignal) {
    runSignal.addEventListener("abort", abortForRunStop, { once: true });
    if (runSignal.aborted) abortForRunStop();
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Operation timed out", "TimeoutError"));
  }, FETCH_TIMEOUT_MS);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (runSignal) runSignal.removeEventListener("abort", abortForRunStop);
    },
    timedOut: () => timedOut,
  };
}

function throwIfStoppedAbort(err: unknown, datasetId: string | undefined): void {
  if (!datasetId || getSignal(datasetId)?.aborted !== true) return;
  if (
    isAbortLikeError(err) ||
    (err instanceof Error && err.name === "TimeoutError")
  ) {
    throw datasetAbortError();
  }
}

function cachedFetchFailure(url: string): string | undefined {
  const cached = recentFetchFailures.get(url);
  if (!cached) return undefined;
  if (Date.now() - cached.at > FETCH_FAILURE_CACHE_TTL_MS) {
    recentFetchFailures.delete(url);
    return undefined;
  }
  console.log(
    `[fetch_page] Skipping recently failed URL: url=${url} error=${cached.code} status=${cached.status ?? "n/a"}`,
  );
  return cached.message;
}

function rememberFetchFailure(
  url: string,
  code: string,
  status: string | undefined,
  message: string,
): void {
  if (!isCacheableFetchFailure(code, status)) return;
  recentFetchFailures.set(url, {
    at: Date.now(),
    code,
    status,
    message,
  });
}

function isCacheableFetchFailure(code: string, status: string | undefined): boolean {
  if (code === "page_not_found" || code === "bot_blocked") return true;
  if (code !== "target_http_error" || !status) return false;
  const statusCode = Number(status);
  return Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500;
}

function fetchPageErrorMessage(code: string, status: string | undefined): string {
  const hints: Record<string, string> = {
    bot_blocked: "This site blocks automated access. Use the search snippet data instead.",
    timeout: "Page took too long to load. Try a different URL.",
    target_unreachable: "Could not connect to this site. Try a different URL.",
    page_not_found: "Page not found (404). The URL may be outdated. Try a different one.",
    target_http_error: `Site returned HTTP ${status ?? "error"}. Try a different URL.`,
  };
  return hints[code] ?? `Fetch failed: ${code}. Try a different URL.`;
}

function buildSearchWebTool(options: WebToolOptions = {}) {
  const datasetId = options.datasetId;
  return createTool({
  id: "search_web",
  description:
    'Search the web for information. Returns a list of results with titles, snippets, and URLs. Call with: {"query": "your search terms"}',
  inputSchema: z.object({
    query: z.string().describe("The search query string"),
  }),
  outputSchema: z.object({
    results: z.array(searchResultSchema).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ query }) => {
    query = query?.trim();
    if (!query)
      return { error: "query is required and cannot be empty." };
    if (datasetId) throwIfDatasetRunAborted(datasetId);

    const apiKey = await getTinyFishApiKey();
    if (!apiKey)
      return { error: "TINYFISH_API_KEY is not configured. Web search is unavailable — use synthetic data instead." };

    const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
    console.log(`[search_web] Searching: "${query}"`);

    const request = timeoutSignalForDataset(datasetId);
    try {
      const res = await fetch(url, {
        headers: tinyFishHeaders(apiKey),
        signal: request.signal,
      });
      if (datasetId) throwIfDatasetRunAborted(datasetId);

      if (!res.ok) {
        const body = await res.text();
        console.error(`[search_web] API error ${res.status}:`, body.slice(0, 200));
        if (res.status === 429)
          return { error: "Search rate limit hit. Wait a moment, or skip web search and use synthetic data." };
        if (res.status === 401)
          return { error: "Invalid TINYFISH_API_KEY. Web search unavailable — use synthetic data." };
        return { error: `Search API returned HTTP ${res.status}. Try a different query or use synthetic data.` };
      }

      const data = await res.json();
      if (datasetId) throwIfDatasetRunAborted(datasetId);
      const results = (data.results ?? []).map((r: Record<string, unknown>) => ({
        title: r.title as string,
        snippet: r.snippet as string,
        url: r.url as string,
      }));

      console.log(`[search_web] Got ${results.length} results`);
      if (results.length === 0)
        return { results: [], error: "No results found for this query. Try a broader search or use synthetic data." };
      return { results };
    } catch (err) {
      throwIfStoppedAbort(err, datasetId);
      if (
        request.timedOut() ||
        (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
      )
        return { error: "Search timed out. Skip web search and use synthetic data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[search_web] Failed:`, msg);
      return { error: `Search failed: ${msg}. Skip web search and use synthetic data.` };
    } finally {
      request.cleanup();
    }
  },
  });
}

function buildFetchPageTool(options: WebToolOptions = {}) {
  const datasetId = options.datasetId;
  return createTool({
  id: "fetch_page",
  description:
    'Fetch a web page and extract its content as clean markdown text. Call with: {"url": "https://example.com/page"}',
  inputSchema: z.object({
    url: z.string().describe("The full URL to fetch, starting with https://"),
  }),
  outputSchema: z.object({
    title: z.string().optional(),
    text: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ url: targetUrl }) => {
    targetUrl = targetUrl?.trim();
    if (!targetUrl)
      return { error: "url is required and cannot be empty." };
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
      return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };
    if (datasetId) throwIfDatasetRunAborted(datasetId);

    const apiKey = await getTinyFishApiKey();
    if (!apiKey)
      return { error: "TINYFISH_API_KEY is not configured. Page fetch is unavailable — use data from search snippets instead." };

    const cachedFailure = cachedFetchFailure(targetUrl);
    if (cachedFailure) return { error: cachedFailure };

    console.log(`[fetch_page] Fetching: ${targetUrl}`);

    const request = timeoutSignalForDataset(datasetId);
    try {
      const res = await fetch("https://api.fetch.tinyfish.ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...tinyFishHeaders(apiKey),
        },
        body: JSON.stringify({ urls: [targetUrl], format: "markdown" }),
        signal: request.signal,
      });
      if (datasetId) throwIfDatasetRunAborted(datasetId);

      if (!res.ok) {
        const body = await res.text();
        console.error(`[fetch_page] API error ${res.status}:`, body.slice(0, 200));
        if (res.status === 429)
          return { error: "Fetch rate limit hit. Use data from search snippets instead." };
        if (res.status === 401)
          return { error: "Invalid TINYFISH_API_KEY. Page fetch unavailable." };
        return { error: `Fetch API returned HTTP ${res.status}. Try a different URL or use search snippet data.` };
      }

      const data = await res.json();
      if (datasetId) throwIfDatasetRunAborted(datasetId);

      if (data.errors?.length > 0) {
        const err = data.errors[0];
        const code = String(err.error ?? "unknown_error");
        const status = err.status === undefined ? undefined : String(err.status);
        const message = fetchPageErrorMessage(code, status);
        console.log(
          `[fetch_page] Failed: url=${targetUrl} error=${code} status=${status ?? "n/a"}`,
        );
        rememberFetchFailure(targetUrl, code, status, message);
        return { error: message };
      }

      const page = data.results?.[0];
      if (!page?.text)
        return { error: "Page loaded but had no extractable text content. Try a different URL." };

      let text = page.text as string;
      const MAX_CHARS = 15000;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n\n[Truncated — showing first ${MAX_CHARS} of ${page.text.length} chars]`;
      }

      console.log(`[fetch_page] Got ${(page.text as string).length} chars from "${page.title}" (returning ${text.length})`);
      return {
        title: page.title as string | undefined,
        text,
      };
    } catch (err) {
      throwIfStoppedAbort(err, datasetId);
      if (
        request.timedOut() ||
        (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
      )
        return { error: "Page fetch timed out. Try a different URL or use search snippet data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fetch_page] Failed:`, msg);
      return { error: `Fetch failed: ${msg}. Use data from search snippets instead.` };
    } finally {
      request.cleanup();
    }
  },
  });
}

export function buildWebTools(options: WebToolOptions = {}) {
  return {
    search_web: buildSearchWebTool(options),
    fetch_page: buildFetchPageTool(options),
  };
}

export const searchWebTool = buildSearchWebTool();
export const fetchPageTool = buildFetchPageTool();
