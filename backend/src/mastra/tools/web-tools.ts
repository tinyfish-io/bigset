import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const FETCH_TIMEOUT_MS = 30_000;

const searchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
});

export const searchWebTool = createTool({
  id: "search_web",
  description:
    "Search the web for information. Returns a list of results with titles, snippets, and URLs. Use this to find real data for the dataset.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  outputSchema: z.object({
    results: z.array(searchResultSchema).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ query }) => {
    if (!query?.trim())
      return { error: "query is required and cannot be empty." };

    const apiKey = process.env.TINYFISH_API_KEY;
    if (!apiKey)
      return { error: "TINYFISH_API_KEY is not configured. Web search is unavailable — use synthetic data instead." };

    const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
    console.log(`[search_web] Searching: "${query}"`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "X-API-Key": apiKey },
        signal: controller.signal,
      });
      clearTimeout(timeout);

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
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError")
        return { error: "Search timed out. Skip web search and use synthetic data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[search_web] Failed:`, msg);
      return { error: `Search failed: ${msg}. Skip web search and use synthetic data.` };
    }
  },
});

export const fetchPageTool = createTool({
  id: "fetch_page",
  description:
    "Fetch a web page and extract its content as clean markdown text. Use this after search_web to read the full content of a page.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch"),
  }),
  outputSchema: z.object({
    title: z.string().optional(),
    text: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ url: targetUrl }) => {
    if (!targetUrl?.trim())
      return { error: "url is required and cannot be empty." };
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
      return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };

    const apiKey = process.env.TINYFISH_API_KEY;
    if (!apiKey)
      return { error: "TINYFISH_API_KEY is not configured. Page fetch is unavailable — use data from search snippets instead." };

    console.log(`[fetch_page] Fetching: ${targetUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.fetch.tinyfish.ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({ urls: [targetUrl], format: "markdown" }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

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

      if (data.errors?.length > 0) {
        const err = data.errors[0];
        console.log(`[fetch_page] Failed: ${err.error}`);
        const hints: Record<string, string> = {
          bot_blocked: "This site blocks automated access. Use the search snippet data instead.",
          timeout: "Page took too long to load. Try a different URL.",
          target_unreachable: "Could not connect to this site. Try a different URL.",
          page_not_found: "Page not found (404). The URL may be outdated. Try a different one.",
          target_http_error: `Site returned HTTP ${err.status ?? "error"}. Try a different URL.`,
        };
        return { error: hints[err.error] ?? `Fetch failed: ${err.error}. Try a different URL.` };
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
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError")
        return { error: "Page fetch timed out. Try a different URL or use search snippet data." };
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fetch_page] Failed:`, msg);
      return { error: `Fetch failed: ${msg}. Use data from search snippets instead.` };
    }
  },
});
