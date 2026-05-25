import type {
  DatasetSpec,
  ExtractedRecord,
  SourceCandidate,
  SourceTriageResult,
} from "../models/schemas.js";
import { scoreDocsUrlForOfficialSource } from "../records/source-urls.js";
import { getDomain, normalizeUrl } from "../utils/url.js";

export interface PromptSourceEntity {
  name: string;
  primaryToken: string;
  domainTokens: string[];
}

export interface PromptSourcePolicy {
  requiresOfficialSource: boolean;
  entities: PromptSourceEntity[];
  searchPhrases: string[];
  explicitSourceUrls: string[];
  hint?: string;
}

const ENTITY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "company",
  "companies",
  "corp",
  "corporation",
  "for",
  "from",
  "inc",
  "llc",
  "ltd",
  "of",
  "official",
  "page",
  "pages",
  "the",
]);

const ENTITY_LIST_INTRODUCER = /\b(?:for|from)\s+([^?.;:]+)/gi;
const ENTITY_LIST_CUTOFF =
  /\b(?:collect|find|include|give|make|show|table|with|need|return|list|shown)\b/i;
const GENERIC_HOSTED_DOMAIN =
  /(?:^|\.)((github|gitlab)\.(io|com)|gitbook\.io|readthedocs\.io|notion\.site|medium\.com|substack\.com)$/i;

function taskTextFromPrompt(prompt: string): string {
  const taskLine = prompt.match(/^Task:\s*(.+)$/im)?.[1];
  return taskLine?.trim() || prompt;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractPromptSourceUrls(prompt: string): string[] {
  return uniqueStrings(
    [...prompt.matchAll(/https?:\/\/[^\s)"'<>]+/gi)].map((match) =>
      normalizeUrl((match[0] ?? "").replace(/[.,;:!?]+$/g, "")),
    ),
  );
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !ENTITY_STOPWORDS.has(token));
}

function looksLikeEntityName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/^(?:and|or|the|official|latest|recent|current)$/i.test(trimmed)) {
    return false;
  }
  return /[A-Z]/.test(trimmed[0] ?? "") || /[a-z][A-Z]/.test(trimmed);
}

function splitEntityList(value: string): string[] {
  const beforeVerb = value.split(ENTITY_LIST_CUTOFF)[0] ?? value;
  const nestedFrom = beforeVerb.match(/\bfrom\s+(.+)$/i)?.[1];
  const entitySegment = nestedFrom ?? beforeVerb;
  return entitySegment
    .replace(/\s+and\s+/gi, ",")
    .split(",")
    .map((part) => part.trim().replace(/^and\s+/i, "").replace(/[.?!]$/g, ""))
    .filter(looksLikeEntityName);
}

function extractExplicitEntities(prompt: string): PromptSourceEntity[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(ENTITY_LIST_INTRODUCER)) {
    names.push(...splitEntityList(match[1] ?? ""));
  }

  return uniqueStrings(names).map((name) => {
    const domainTokens = tokenize(name);
    return {
      name,
      primaryToken: domainTokens.at(-1) ?? name.toLowerCase(),
      domainTokens,
    };
  });
}

function searchPhrasesForPrompt(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const phrases: string[] = [];

  if (lower.includes("pricing")) {
    phrases.push("official pricing page", "billing pricing");
  }
  if (lower.includes("investor relations") || lower.includes("earnings release")) {
    phrases.push("reports quarterly results", "investor relations earnings release");
  }
  if (lower.includes("mcp")) {
    phrases.push("MCP connector docs", "model context protocol docs");
  } else if (lower.includes("docs") || lower.includes("documentation")) {
    phrases.push("official docs");
  }
  if (lower.includes("blog post") || lower.includes("blog posts")) {
    phrases.push("official blog latest post");
  }
  if (lower.includes("official website") || lower.includes("official websites")) {
    phrases.push("official website");
  }
  if (lower.includes("official") && phrases.length === 0) {
    phrases.push("official source");
  }

  return uniqueStrings(phrases);
}

function wantsDocsSource(policy: PromptSourcePolicy): boolean {
  return policy.searchPhrases.some((phrase) =>
    /\b(?:docs|documentation|mcp|model context protocol)\b/i.test(phrase),
  );
}

function isWeakDocsSurface(url: string): boolean {
  return /\b(?:blog|news|course|academy|directory|skilljar)\b/i.test(url);
}

function preferredDocsHost(entity: PromptSourceEntity): string {
  const primary = entity.primaryToken.toLowerCase();
  if (primary === "openai") return "developers.openai.com";
  if (primary === "cloudflare") return "developers.cloudflare.com";
  if (primary === "anthropic") return "platform.claude.com";
  return `docs.${primary}.com`;
}

function officialDomainAliasesForEntity(entity: PromptSourceEntity): string[] {
  const primary = entity.primaryToken.toLowerCase();
  if (primary === "anthropic") {
    return ["docs.anthropic.com", "platform.claude.com"];
  }
  return [];
}

export function derivePromptSourcePolicy(prompt: string): PromptSourcePolicy {
  const taskText = taskTextFromPrompt(prompt);
  const entities = extractExplicitEntities(taskText);
  const searchPhrases = searchPhrasesForPrompt(taskText);
  const explicitSourceUrls = extractPromptSourceUrls(taskText);
  const lower = taskText.toLowerCase();
  const asksForCanonicalSource =
    searchPhrases.length > 0 ||
    lower.includes("source url") ||
    lower.includes("source page");
  const requiresOfficialSource =
    entities.length > 0 &&
    asksForCanonicalSource &&
    (lower.includes("official") ||
      lower.includes("pricing") ||
      lower.includes("investor relations") ||
      lower.includes("earnings release") ||
      lower.includes("docs") ||
      lower.includes("documentation") ||
      lower.includes("blog post"));

  const hint = requiresOfficialSource
    ? [
        "Prompt source policy: user requested canonical/official sources for named entities.",
        `Named entities: ${entities.map((entity) => entity.name).join(", ")}.`,
        "Use official entity-owned domains for source_url, evidence, pricing/docs/blog/IR URLs, and required facts.",
        "Use third-party pages only for discovery; do not use them as evidence when an official entity-owned page is available.",
      ].join("\n")
    : undefined;

  return { requiresOfficialSource, entities, searchPhrases, explicitSourceUrls, hint };
}

export function promptSourceSearchQueries(policy: PromptSourcePolicy): string[] {
  if (!policy.requiresOfficialSource || policy.entities.length === 0) {
    return [];
  }

  const phrases = policy.searchPhrases.length
    ? policy.searchPhrases
    : ["official source"];
  const primaryPhrase = phrases[0] ?? "official source";
  const siteQualifiedDocsQueries = wantsDocsSource(policy)
    ? policy.entities.map(
        (entity) =>
          `${entity.name} ${primaryPhrase} site:${preferredDocsHost(entity)}`,
      )
    : [];

  return uniqueStrings(
    [
      ...siteQualifiedDocsQueries,
      ...policy.entities.flatMap((entity) =>
        phrases.map((phrase) => `${entity.name} ${phrase}`),
      ),
    ],
  );
}

export function applyPromptSourcePolicyToSpec(
  spec: DatasetSpec,
  prompt: string,
): DatasetSpec {
  const policy = derivePromptSourcePolicy(prompt);
  if (!policy.requiresOfficialSource) {
    return spec;
  }

  return {
    ...spec,
    search_queries: uniqueStrings([
      ...promptSourceSearchQueries(policy),
      ...spec.search_queries,
    ]),
    extraction_hints: [spec.extraction_hints, policy.hint]
      .filter(Boolean)
      .join("\n"),
  };
}

export function urlMatchesPromptSourcePolicy(
  url: string,
  policy: PromptSourcePolicy,
): boolean {
  if (urlMatchesExplicitPromptSource(url, policy)) return true;
  if (!policy.requiresOfficialSource) return true;
  const domain = getDomain(url).toLowerCase();
  if (GENERIC_HOSTED_DOMAIN.test(domain)) {
    return false;
  }
  return policy.entities.some(
    (entity) => urlMatchesEntitySourcePolicy(url, entity, policy),
  );
}

function urlMatchesExplicitPromptSource(
  url: string,
  policy: PromptSourcePolicy,
): boolean {
  const normalized = normalizeUrl(url);
  return policy.explicitSourceUrls.some((sourceUrl) => {
    const explicit = normalizeUrl(sourceUrl);
    return normalized === explicit || normalized.startsWith(`${explicit}/`);
  });
}

function urlMatchesEntitySourcePolicy(
  url: string,
  entity: PromptSourceEntity,
  policy: PromptSourcePolicy,
): boolean {
  const domain = getDomain(url).toLowerCase();
  if (GENERIC_HOSTED_DOMAIN.test(domain)) {
    return false;
  }
  const entityOwnedDomain =
    domain.includes(entity.primaryToken) ||
    officialDomainAliasesForEntity(entity).some((alias) =>
      domain.endsWith(alias),
    );
  if (!entityOwnedDomain) {
    return false;
  }
  if (wantsDocsSource(policy) && isWeakDocsSurface(url)) {
    return false;
  }
  return true;
}

export function sourceCandidatePolicyBoost(
  candidate: SourceCandidate,
  policy: PromptSourcePolicy,
): number {
  if (!policy.requiresOfficialSource) return 0;

  const searchableText = [
    candidate.url,
    candidate.title,
    candidate.snippet,
    candidate.site_name,
  ]
    .join(" ")
    .toLowerCase();
  const matchedEntity = policy.entities.some((entity) =>
    entity.domainTokens.some((token) => searchableText.includes(token)),
  );
  const matchedDomain = urlMatchesPromptSourcePolicy(candidate.url, policy);
  const officialLanguage =
    /\b(official|pricing|docs|documentation|investor relations|earnings|blog)\b/.test(
      searchableText,
    );
  const docsSurface =
    wantsDocsSource(policy) &&
    /(?:^|\/\/)(?:docs|developers)\.|\/(?:docs|documentation|guides|api\/docs|agents)(?:\/|$)/.test(
      searchableText,
    );
  const weakDocsSurface =
    wantsDocsSource(policy) &&
    /\b(?:blog|news|course|academy|directory|skilljar)\b/.test(searchableText);

  if (matchedDomain && matchedEntity && docsSurface) return 7;
  if (matchedDomain && matchedEntity && officialLanguage) {
    return weakDocsSurface ? 2 : 5;
  }
  if (matchedDomain && matchedEntity) return weakDocsSurface ? 1 : 4;
  if (matchedDomain) return 3;
  if (matchedEntity && officialLanguage) return 1;
  return -2;
}

export function applyPromptSourcePolicyToTriageResult(
  result: SourceTriageResult,
  policy: PromptSourcePolicy,
): SourceTriageResult {
  if (
    !policy.requiresOfficialSource ||
    ![
      "extract_now",
      "requires_navigation",
      "requires_form_submission",
      "requires_detail_page_followup",
    ].includes(result.status) ||
    urlMatchesPromptSourcePolicy(result.final_url || result.url, policy)
  ) {
    return result;
  }

  const domain = getDomain(result.final_url || result.url);
  return {
    ...result,
    status: "low_value",
    source_data_confidence: Math.min(result.source_data_confidence, 0.3),
    expected_yield: "none",
    reasoning:
      `Prompt asks for official/canonical sources for named entities; ${domain} ` +
      `does not match ${policy.entities.map((entity) => entity.name).join(", ")}. ` +
      `Original triage: ${result.reasoning}`,
    suggested_action:
      result.suggested_action ??
      "Search/fetch the named entity's official domain instead of extracting this third-party page.",
  };
}

export function recordMatchesPromptSourcePolicy(
  record: ExtractedRecord,
  spec: DatasetSpec,
  policy: PromptSourcePolicy,
): boolean {
  if (!policy.requiresOfficialSource) {
    return true;
  }

  const entity = matchingPromptEntityForRecord(record, spec, policy);
  if (!entity) {
    return true;
  }

  const urls = urlsForRecordSourcePolicy(record, spec);
  if (urls.length === 0) {
    return false;
  }
  if (urls.some((url) => urlMatchesExplicitPromptSource(url, policy))) {
    return true;
  }

  return urls.some((url) => urlMatchesEntitySourcePolicy(url, entity, policy));
}

function matchingPromptEntityForRecord(
  record: ExtractedRecord,
  spec: DatasetSpec,
  policy: PromptSourcePolicy,
): PromptSourceEntity | null {
  const primaryColumn =
    spec.dedupe_keys[0] ??
    spec.columns.find((column) =>
      /(name|title|company|organization|entity)/i.test(column.name),
    )?.name;
  const primaryValue = String(
    primaryColumn ? record.row[primaryColumn] ?? "" : "",
  ).toLowerCase();
  const rowText = Object.values(record.row).join(" ").toLowerCase();

  return (
    policy.entities.find((entity) => {
      const name = entity.name.toLowerCase();
      return (
        primaryValue.includes(name) ||
        primaryValue.includes(entity.primaryToken) ||
        rowText.includes(name)
      );
    }) ?? null
  );
}

function urlsForRecordSourcePolicy(
  record: ExtractedRecord,
  spec: DatasetSpec,
): string[] {
  const urls = new Set<string>();
  for (const url of record.source_urls) {
    if (isHttpUrl(url)) urls.add(url.trim());
  }
  for (const column of spec.columns) {
    if (!isUrlLikeColumnName(column.name)) continue;
    const value = record.row[column.name];
    if (isHttpUrl(value)) urls.add(value.trim());
  }
  return [...urls].sort((a, b) => {
    return scoreDocsUrlForOfficialSource(b) - scoreDocsUrlForOfficialSource(a);
  });
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isUrlLikeColumnName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "url" || lower.endsWith("_url") || lower.includes("url");
}
