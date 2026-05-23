import { TinyFish } from "@tiny-fish/sdk";
import { config } from "../config.js";
import type { FetchedPage, SourceCandidate } from "../models/schemas.js";

let client: TinyFish | null = null;

function getClient(): TinyFish {
  if (!client) {
    client = new TinyFish({ apiKey: config.tinyfishApiKey });
  }
  return client;
}

export async function searchWeb(
  query: string,
  page = 0,
): Promise<SourceCandidate[]> {
  const response = await getClient().search.query({ query, page });
  return response.results.map((result) => ({
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    site_name: result.site_name,
    query,
    position: result.position,
    search_page: page,
  }));
}

export async function fetchPages(
  urls: string[],
  options?: { includeLinks?: boolean },
): Promise<FetchedPage[]> {
  if (urls.length === 0) return [];

  const response = await getClient().fetch.getContents({
    urls,
    format: "markdown",
    links: options?.includeLinks ?? false,
  });

  const pages: FetchedPage[] = response.results.map((page) => ({
    url: page.url,
    final_url: page.final_url ?? page.url,
    title: page.title ?? "",
    description: page.description ?? undefined,
    text: typeof page.text === "string" ? page.text : JSON.stringify(page.text),
    outbound_links: page.links,
  }));

  for (const err of response.errors) {
    pages.push({
      url: err.url,
      final_url: err.url,
      title: "",
      text: "",
      error: err.error,
    });
  }

  return pages;
}

export function chunkUrls(urls: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += size) {
    chunks.push(urls.slice(i, i + size));
  }
  return chunks;
}
