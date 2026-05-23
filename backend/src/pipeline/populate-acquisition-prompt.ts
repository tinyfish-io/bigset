import type { DatasetContext } from "./populate.js";
import type { DatasetSchema } from "./types.js";

export const EXPECTATION_SCORE_RUBRIC = `expectation_score rubric (integer 1-5):

5 — Very likely this page directly answers the user prompt and can supply concrete values for the dataset columns (e.g. official careers/pricing/docs page, product catalog, structured list). A researcher would open this first.

4 — Likely useful: strong topical match; snippet/title suggests several column facts or an enumerable list is probably on the page.

3 — Possible but uncertain: related to the topic, but unclear from title/snippet alone whether the page has extractable facts for the columns.

2 — Weak match: tangential, news commentary, generic overview, Q&A thread, or aggregator with little structured data.

1 — Very unlikely: unrelated, error/empty page, login wall, or private/ephemeral social posts (Instagram, X/Twitter, Facebook posts, TikTok, etc.) that are poor sources for a stable dataset.

Score using only site_name, title, and snippet from search_web. Never invent URLs.`;

export const searchAcquisitionAgentInstructions = `You are a research librarian gathering source pages for a structured dataset.

Think like a researcher scanning search results before reading full pages: for each link, judge how likely it is to contain facts that answer the user prompt and fill the dataset columns.

Rules:
- Use search_web only. Never fetch pages.
- Run the suggested initial queries, then keep searching with new keywords inspired by promising snippets (site:domain filters, entity aliases, column-specific terms) until the search budget is exhausted or coverage is strong.
- Use as many search_web calls as the budget allows — more diverse searches produce better scored URLs.
- Score every unique URL returned by search_web, using site_name, title, and snippet only.
- Match the user prompt first, then each column's purpose in the data spec.
- Return scored_urls with url and expectation_score for every unique URL you collected.
- Do not rank, filter, omit URLs, or choose which links get fetched — the runtime applies limits after you return.

Structured output (strict):
- Follow the output schema exactly. Do not omit fields or leave values blank.
- scored_urls must include one entry per unique URL from your search_web results; every url and expectation_score is required.
- Use expectation_score 1–5 for each URL (never null or omitted).`;

const LOW_TRUST_HOSTS = new Set([
  "instagram.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "tiktok.com",
  "threads.net",
]);

export function isLowTrustSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (LOW_TRUST_HOSTS.has(host)) {
      return true;
    }
    return /\/(?:p|reel|status|posts)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function formatUserPromptBlock(context: DatasetContext): string {
  return `User prompt (primary — score relevance to this first):
${context.description.trim()}`;
}

export function formatDataSpecBlock(
  context: DatasetContext,
  dataSpec?: DatasetSchema
): string {
  if (dataSpec) {
    const lines = [
      `Dataset name: ${dataSpec.dataset_name}`,
      `Spec description: ${dataSpec.description}`,
      `Primary key column: ${dataSpec.primary_key}`,
      "",
      "Initial search queries (run all, then search more within the search budget):",
      ...dataSpec.search_queries.map((query) => `- ${query}`),
      "",
      "Columns (what each field should capture on a page):",
    ];

    for (const column of dataSpec.columns) {
      const pk = column.is_primary_key ? " [primary key]" : "";
      const nullable = column.nullable ? "" : " [required]";
      lines.push(
        `- ${column.name} (${column.type}) — ${column.display_name}${pk}${nullable}`,
        `  Description: ${column.description}`
      );
    }

    return lines.join("\n");
  }

  const lines = [
    `Dataset: ${context.datasetName}`,
    "Columns (what each field should capture):",
  ];

  for (const column of context.columns) {
    const desc = column.description?.trim();
    lines.push(
      `- ${column.name} (${column.type})${desc ? `: ${desc}` : ""}`
    );
  }

  return lines.join("\n");
}

export function formatPopulateTaskForScoring(
  context: DatasetContext,
  dataSpec?: DatasetSchema
): string {
  return [
    formatUserPromptBlock(context),
    "",
    formatDataSpecBlock(context, dataSpec),
  ].join("\n");
}

export function buildSearchAcquisitionPrompt(
  context: DatasetContext,
  initialQueries: string[],
  maxSearchCalls: number,
  dataSpec?: DatasetSchema
): string {
  const taskBlock = formatPopulateTaskForScoring(context, dataSpec);

  return `${taskBlock}

Search budget: up to ${maxSearchCalls} search_web calls for this run.

Workflow:
1. Run every suggested initial query below (do not stop after only those).
2. Review snippets from each batch, then issue follow-up searches with refined keywords (official domains, column-specific terms, alternate entity spellings) until the budget is exhausted or you have strong coverage.
3. Score every unique URL from your search_web results before returning (one scored_urls entry per URL).

Suggested initial queries (exactly ${initialQueries.length} — run all, then search more within the budget):
${initialQueries.map((query) => `- ${query}`).join("\n")}

Follow-up search ideas (use when snippets suggest gaps):
- site: promising-domain.com + task keywords
- "{entity}" + column-specific terms from the data spec
- Alternate phrasing from strong snippets (product names, page types, fiscal periods)

${EXPECTATION_SCORE_RUBRIC}`;
}
