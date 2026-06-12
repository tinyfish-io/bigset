import { chromium, type Browser, type Page } from "playwright-core";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { getSignal } from "../abort-registry.js";
import { convex, internal } from "../convex.js";
import { FETCH_TIMEOUT_MS } from "../fetch-timeout.js";
import {
  getTinyFishApiKey,
  requireOpenRouterApiKey,
  tinyFishHeaders,
} from "../local-credentials.js";
import type { PopulateColumn } from "../pipeline/populate.js";
import { DEFAULT_MODEL_IDS } from "../config/models.js";

type ExtractorStatus = "inserted" | "updated" | "unchanged" | "miss" | "failed";
type ExtractedValue = string | number | boolean;

export interface TryRowExtractorInput {
  datasetId: string;
  datasetName?: string;
  description?: string;
  columns: PopulateColumn[];
  primaryKeys: Record<string, string>;
  urls?: string[];
  context?: string;
  retrievalStrategy?: "search_fetch" | "browser" | "hybrid";
  sourceHint?: string;
  browserAttempts?: number;
  extractorBuilderModel?: string;
}

export interface TryRefreshRowExtractorInput extends TryRowExtractorInput {
  rowId: string;
  existingData: Record<string, unknown>;
}

export interface TryRowExtractorResult {
  status: ExtractorStatus;
  reason: string;
  rowSummary?: string;
  sources?: string[];
}

interface TinyFishBrowserSession {
  session_id: string;
  cdp_url: string;
  base_url: string;
}

interface PageEvidence {
  finalUrl: string;
  title?: string;
  description?: string;
  candidates: Record<string, string[]>;
  bodyText: string;
}

interface GenericExtraction {
  data: Record<string, ExtractedValue>;
  sources: string[];
  rowSummary?: string;
  extractedColumns: string[];
  missingColumns: string[];
}

interface GeneratedExtractorResult {
  data?: Record<string, unknown>;
  sources?: unknown;
  row_summary?: unknown;
  rowSummary?: unknown;
  how_found?: unknown;
  howFound?: unknown;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const BROWSER_TIMEOUT_MS = 45_000;
const CDP_CONNECT_TIMEOUT_MS = 45_000;
const DEFAULT_BROWSER_ATTEMPTS = 2;
const EXTRACTOR_RUNNER_TIMEOUT_MS = 60_000;
const EXTRACTOR_SCRIPT_OUTPUT_LIMIT = 256_000;
const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GENERIC_EXTRACTOR_HOW_FOUND =
  "Opened the row target with TinyFish Browser and ran the dataset's generated Playwright extractor.";
const GENERIC_REFRESH_HOW_FOUND =
  "Refreshed the row target with TinyFish Browser and ran the dataset's generated Playwright extractor.";
const EXTRACTOR_RUNNER_SOURCE = `
import { chromium } from "playwright-core";
import vm from "node:vm";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const browser = await chromium.connectOverCDP(payload.cdpUrl, { timeout: 45000 });
let timeout;

const cleanText = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
const parseCompactNumber = (value) => {
  const normalized = String(value ?? "").replace(/,/g, "");
  const match = normalized.match(/[$€£]?\\s*([\\d]+(?:\\.\\d+)?)\\s*([kmb])?/i) || normalized.match(/([\\d]+(?:\\.\\d+)?)/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "k" ? 1000 : suffix === "m" ? 1000000 : suffix === "b" ? 1000000000 : 1;
  return Math.round(base * multiplier * 100) / 100;
};
const helpers = {
  cleanText,
  parseNumber: parseCompactNumber,
  parseCompactNumber,
  parsePrice: parseCompactNumber,
  parseRating: parseCompactNumber,
  absoluteUrl: (value, base = payload.url) => {
    try {
      return new URL(String(value ?? ""), base).toString();
    } catch {
      return "";
    }
  },
};

try {
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const sandbox = {
    URL,
    Date,
    Math,
    JSON,
    RegExp,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const compiled = new vm.Script(payload.script + "\\n;globalThis.__extract = extract;", {
    filename: "generated-extractor.js",
  });
  compiled.runInContext(sandbox, { timeout: 1000 });
  const extract = sandbox.__extract;
  if (typeof extract !== "function") throw new Error("extract is not a function");

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("extract timed out")), payload.timeoutMs);
  });
  const result = await Promise.race([
    extract({ page, input: payload.input, helpers }),
    timeoutPromise,
  ]);
  process.stdout.write(JSON.stringify(result ?? {}));
} finally {
  if (timeout) clearTimeout(timeout);
  await browser.close().catch(() => {});
}
`;

export async function tryRowExtractor(
  input: TryRowExtractorInput,
): Promise<TryRowExtractorResult> {
  if (!ENABLED_VALUES.has((process.env.ROW_EXTRACTORS_ENABLED ?? "").toLowerCase())) {
    return { status: "miss", reason: "row extractors are disabled" };
  }

  const url = initialBrowserUrl(input);
  if (!url) return { status: "miss", reason: "no browser start URL or row context" };

  try {
    const extraction = await extractGenericRow(input, url);
    if (!hasExtractedNonPrimaryValue(extraction, input.columns)) {
      return {
        status: "miss",
        reason: `TinyFish Browser did not extract non-primary fields from ${safeHost(url)}`,
      };
    }

    await convex.mutation(internal.datasetRows.insert, {
      datasetId: input.datasetId,
      data: extraction.data,
      sources: extraction.sources,
      rowSummary: extraction.rowSummary,
      howFound: GENERIC_EXTRACTOR_HOW_FOUND,
    });

    return {
      status: "inserted",
      reason: `Inserted by generic browser extractor (${extraction.extractedColumns.join(", ")})`,
      rowSummary: extraction.rowSummary,
      sources: extraction.sources,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate/i.test(msg)) {
      return {
        status: "miss",
        reason: `${msg} Move on to the next entity.`,
      };
    }
    return { status: "failed", reason: msg };
  }
}

export async function tryRefreshRowExtractor(
  input: TryRefreshRowExtractorInput,
): Promise<TryRowExtractorResult> {
  if (!ENABLED_VALUES.has((process.env.ROW_EXTRACTORS_ENABLED ?? "").toLowerCase())) {
    return { status: "miss", reason: "row extractors are disabled" };
  }

  const url = initialBrowserUrl(input);
  if (!url) return { status: "miss", reason: "no browser start URL or row context" };

  try {
    const extraction = await extractGenericRow(input, url, input.existingData);
    if (!hasExtractedNonPrimaryValue(extraction, input.columns)) {
      return {
        status: "miss",
        reason: `TinyFish Browser did not extract non-primary fields from ${safeHost(url)}`,
      };
    }

    const changedColumns = changedColumnNames(
      extraction.data,
      input.existingData,
      input.columns,
    );
    if (changedColumns.length === 0) {
      return {
        status: "unchanged",
        reason: "Verified unchanged by generic browser extractor",
        rowSummary: extraction.rowSummary,
        sources: extraction.sources,
      };
    }

    await convex.mutation(internal.datasetRows.update, {
      id: input.rowId,
      expectedDatasetId: input.datasetId,
      data: extraction.data,
      sources: extraction.sources,
      rowSummary: extraction.rowSummary,
      howFound: GENERIC_REFRESH_HOW_FOUND,
    });

    return {
      status: "updated",
      reason: `Updated by generic browser extractor (${changedColumns.join(", ")})`,
      rowSummary: extraction.rowSummary,
      sources: extraction.sources,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed", reason: msg };
  }
}

function initialBrowserUrl(input: TryRowExtractorInput): string | undefined {
  const explicitUrl = [
    ...Object.values(input.primaryKeys),
    ...(input.urls ?? []),
    input.sourceHint,
    input.context?.match(/https?:\/\/[^\s)>"']+/i)?.[0],
  ]
    .map(coerceHttpUrl)
    .find((value): value is string => Boolean(value));
  if (explicitUrl) return explicitUrl;

  const searchQuery = [
    input.sourceHint,
    input.datasetName,
    input.description,
    ...Object.values(input.primaryKeys),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .slice(0, 500);

  if (!searchQuery) return undefined;
  return `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/[.,;:]+$/, "");
}

function coerceHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeUrl(value);
  if (isHttpUrl(normalized)) return normalized;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(normalized)) {
    const withScheme = `https://${normalized}`;
    return isHttpUrl(withScheme) ? withScheme : undefined;
  }
  return undefined;
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(normalizeUrl(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid-url";
  }
}

async function extractGenericRow(
  input: TryRowExtractorInput,
  url: string,
  existingData?: Record<string, unknown>,
): Promise<GenericExtraction> {
  const apiKey = await getTinyFishApiKey();
  if (!apiKey) throw new Error("TINYFISH_API_KEY is not configured");

  const script = await getOrBuildExtractorScript(apiKey, input, url);
  const attempts = normalizedBrowserAttempts(input.browserAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await runGeneratedExtractorScript(apiKey, input, url, script);
      return buildRowFromExtractorResult(input, url, raw, existingData);
    } catch (err) {
      lastError = err;
      if (getSignal(input.datasetId)?.aborted || attempt === attempts) break;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[row_extractor] Browser attempt ${attempt}/${attempts} failed; retrying: ${msg}`,
      );
    }
  }

  const failure = lastError instanceof Error ? lastError.message : String(lastError);
  try {
    console.warn(
      `[row_extractor] generated extractor failed; requesting repair: ${failure}`,
    );
    const repaired = await repairExtractorAfterRuntimeFailure(
      apiKey,
      input,
      url,
      script,
      failure,
    );
    const raw = await runGeneratedExtractorScript(apiKey, input, url, repaired);
    return buildRowFromExtractorResult(input, url, raw, existingData);
  } catch (repairErr) {
    await markExtractorFailed(input, url, repairErr).catch(() => undefined);
    throw repairErr instanceof Error ? repairErr : new Error(String(repairErr));
  }
}

function normalizedBrowserAttempts(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BROWSER_ATTEMPTS;
  }
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

async function getOrBuildExtractorScript(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
): Promise<string> {
  const siteKey = siteKeyForInput(input, url);
  const columnsHash = hashColumns(input.columns);
  const existing = (await convex.query(internal.datasetExtractors.getActive, {
    datasetId: input.datasetId,
    siteKey,
    columnsHash,
  })) as { script?: string } | null;
  if (existing?.script) return existing.script;

  const evidence = await probePage(apiKey, input.datasetId, url);
  const modelSlug = input.extractorBuilderModel ?? DEFAULT_MODEL_IDS.EXTRACTOR_BUILDER;
  const script = await buildExtractorScript(input, url, evidence, modelSlug);
  const validation = await validateExtractorScript(apiKey, input, url, script);
  if (validation.ok) {
    await convex.mutation(internal.datasetExtractors.upsert, {
      datasetId: input.datasetId,
      siteKey,
      columnsHash,
      script,
      model: modelSlug,
      probeSummary: summarizeEvidenceForStorage(evidence),
    });
    return script;
  }

  const repaired = await repairExtractorScript(
    input,
    url,
    evidence,
    script,
    validation.reason,
    modelSlug,
  );
  const repairedValidation = await validateExtractorScript(apiKey, input, url, repaired);
  if (!repairedValidation.ok) {
    throw new Error(`generated extractor failed validation: ${repairedValidation.reason}`);
  }

  await convex.mutation(internal.datasetExtractors.upsert, {
    datasetId: input.datasetId,
    siteKey,
    columnsHash,
    script: repaired,
    model: modelSlug,
    probeSummary: summarizeEvidenceForStorage(evidence),
  });
  return repaired;
}

async function probePage(
  apiKey: string,
  datasetId: string,
  url: string,
): Promise<PageEvidence> {
  const session = await createTinyFishBrowserSession(apiKey, url, datasetId);
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(session.cdp_url, {
      timeout: CDP_CONNECT_TIMEOUT_MS,
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
      // Many modern sites keep long-lived requests open. DOMContentLoaded is enough.
    });

    return await readPageEvidence(page);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function createTinyFishBrowserSession(
  apiKey: string,
  url: string,
  datasetId: string,
): Promise<TinyFishBrowserSession> {
  const response = await withRunTimeoutSignal(datasetId, FETCH_TIMEOUT_MS, (signal) =>
    fetch("https://agent.tinyfish.ai/v1/browser", {
      method: "POST",
      headers: {
        ...tinyFishHeaders(apiKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url }),
      signal,
    }),
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `TinyFish Browser returned HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as Partial<TinyFishBrowserSession>;
  if (!data.session_id || !data.cdp_url || !data.base_url) {
    throw new Error("TinyFish Browser response did not include CDP connection details");
  }

  return {
    session_id: data.session_id,
    cdp_url: data.cdp_url,
    base_url: data.base_url,
  };
}

async function withRunTimeoutSignal<T>(
  datasetId: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const runSignal = getSignal(datasetId);
  if (runSignal?.aborted) throw new DOMException("Run was stopped", "AbortError");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Timed out", "TimeoutError")),
    timeoutMs,
  );
  const abortFromRun = () =>
    controller.abort(runSignal?.reason ?? new DOMException("Run was stopped", "AbortError"));

  runSignal?.addEventListener("abort", abortFromRun, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    runSignal?.removeEventListener("abort", abortFromRun);
  }
}

async function readPageEvidence(page: Page): Promise<PageEvidence> {
  const finalUrl = page.url();
  const evidence = await page.evaluate(() => {
    const normalize = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const clean = (value: unknown) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const candidates: Record<string, string[]> = {};
    const push = (key: unknown, value: unknown) => {
      const normalizedKey = normalize(clean(key));
      const cleanedValue = clean(value);
      if (!normalizedKey || !cleanedValue || cleanedValue.length > 2_000) return;
      const list = candidates[normalizedKey] ?? [];
      if (list.length >= 8 || list.includes(cleanedValue)) return;
      candidates[normalizedKey] = [...list, cleanedValue];
    };
    const text = (selector: string) =>
      clean(document.querySelector(selector)?.textContent ?? "");
    const attr = (selector: string, name: string) =>
      clean(document.querySelector(selector)?.getAttribute(name) ?? "");

    const title =
      text("h1") ||
      attr("meta[property='og:title']", "content") ||
      attr("meta[name='twitter:title']", "content") ||
      clean(document.title);
    const description =
      attr("meta[name='description']", "content") ||
      attr("meta[property='og:description']", "content") ||
      attr("meta[name='twitter:description']", "content");

    push("title", title);
    push("name", title);
    push("description", description);
    push("summary", description);
    push("url", location.href);
    push("canonical", attr("link[rel='canonical']", "href"));

    document.querySelectorAll("meta[name][content], meta[property][content]").forEach((el) => {
      const key = el.getAttribute("name") || el.getAttribute("property");
      push(key, el.getAttribute("content"));
    });

    const walkJson = (value: unknown, path: string[] = []) => {
      if (value == null) return;
      if (Array.isArray(value)) {
        value.slice(0, 40).forEach((item, index) => walkJson(item, [...path, String(index)]));
        return;
      }
      if (typeof value === "object") {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          walkJson(nested, [...path, key]);
        }
        return;
      }
      const leaf = clean(value);
      if (!leaf) return;
      const key = path[path.length - 1] ?? "";
      push(key, leaf);
      push(path.filter((part) => !/^\d+$/.test(part)).join("_"), leaf);
    };

    document.querySelectorAll("script[type*='ld+json']").forEach((script) => {
      try {
        walkJson(JSON.parse(script.textContent || ""));
      } catch {
        // Ignore malformed structured data.
      }
    });

    document.querySelectorAll("table tr").forEach((row) => {
      const cells = Array.from(row.querySelectorAll("th,td"))
        .map((cell) => clean(cell.textContent))
        .filter(Boolean);
      if (cells.length >= 2) push(cells[0], cells.slice(1).join(" "));
    });

    document.querySelectorAll("dt").forEach((dt) => {
      let sibling = dt.nextElementSibling;
      while (sibling && sibling.tagName.toLowerCase() !== "dd") {
        sibling = sibling.nextElementSibling;
      }
      if (sibling) push(dt.textContent, sibling.textContent);
    });

    document.querySelectorAll("li,p,div,span").forEach((el) => {
      const value = clean(el.textContent);
      if (value.length < 4 || value.length > 500) return;
      const match = value.match(/^([^:|\n]{2,80})\s*[:|]\s*(.{1,350})$/);
      if (match) push(match[1], match[2]);
    });

    document.querySelectorAll("a[href]").forEach((el) => {
      const label = clean(el.textContent) || clean(el.getAttribute("aria-label"));
      const href = clean((el as HTMLAnchorElement).href);
      if (!href || !/^https?:\/\//i.test(href)) return;
      push(label || "link", href);
      if (/website|homepage|site/i.test(label)) push("website", href);
    });

    return {
      title,
      description,
      candidates,
      bodyText: clean(document.body?.innerText ?? "").slice(0, 60_000),
    };
  });

  return { ...evidence, finalUrl };
}

async function buildExtractorScript(
  input: TryRowExtractorInput,
  url: string,
  evidence: PageEvidence,
  modelSlug: string,
): Promise<string> {
  const openrouter = createOpenRouter({
    apiKey: await requireOpenRouterApiKey(),
    baseURL: process.env.OPENROUTER_BASE_URL,
  });
  const result = await generateText({
    model: openrouter(modelSlug),
    prompt: extractorBuilderPrompt(input, url, evidence),
    maxOutputTokens: 4_000,
    abortSignal: getSignal(input.datasetId),
  });
  return sanitizeGeneratedScript(result.text);
}

async function repairExtractorScript(
  input: TryRowExtractorInput,
  url: string,
  evidence: PageEvidence,
  script: string,
  failure: string,
  modelSlug: string,
): Promise<string> {
  const openrouter = createOpenRouter({
    apiKey: await requireOpenRouterApiKey(),
    baseURL: process.env.OPENROUTER_BASE_URL,
  });
  const result = await generateText({
    model: openrouter(modelSlug),
    prompt: `${extractorBuilderPrompt(input, url, evidence)}

The previous extractor failed validation.

Failure:
${failure}

Previous extractor:
\`\`\`js
${script}
\`\`\`

Return a repaired extractor only.`,
    maxOutputTokens: 4_000,
    abortSignal: getSignal(input.datasetId),
  });
  return sanitizeGeneratedScript(result.text);
}

async function repairExtractorAfterRuntimeFailure(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
  failure: string,
): Promise<string> {
  const evidence = await probePage(apiKey, input.datasetId, url);
  const modelSlug = input.extractorBuilderModel ?? DEFAULT_MODEL_IDS.EXTRACTOR_BUILDER;
  const repaired = await repairExtractorScript(
    input,
    url,
    evidence,
    script,
    failure,
    modelSlug,
  );
  const validation = await validateExtractorScript(apiKey, input, url, repaired);
  if (!validation.ok) {
    throw new Error(`repaired extractor failed validation: ${validation.reason}`);
  }

  await convex.mutation(internal.datasetExtractors.upsert, {
    datasetId: input.datasetId,
    siteKey: siteKeyForInput(input, url),
    columnsHash: hashColumns(input.columns),
    script: repaired,
    model: modelSlug,
    probeSummary: summarizeEvidenceForStorage(evidence),
  });
  return repaired;
}

async function markExtractorFailed(
  input: TryRowExtractorInput,
  url: string,
  err: unknown,
): Promise<void> {
  await convex.mutation(internal.datasetExtractors.markFailed, {
    datasetId: input.datasetId,
    siteKey: siteKeyForInput(input, url),
    columnsHash: hashColumns(input.columns),
    error: err instanceof Error ? err.message : String(err),
  });
}

function extractorBuilderPrompt(
  input: TryRowExtractorInput,
  url: string,
  evidence: PageEvidence,
): string {
  const columns = input.columns
    .map(
      (column) => {
        const details = [
          column.isPrimaryKey ? "PRIMARY KEY" : undefined,
          column.nullable === undefined ? undefined : `nullable=${column.nullable}`,
          column.validationRegex ? `validation_regex=${JSON.stringify(column.validationRegex)}` : undefined,
          column.normalizationHint ? `normalization_hint=${JSON.stringify(column.normalizationHint)}` : undefined,
          column.description ? `retrieval_hint=${JSON.stringify(column.description)}` : undefined,
        ].filter(Boolean);
        return `- ${JSON.stringify(column.name)} (${column.type})${details.length > 0 ? ` [${details.join("; ")}]` : ""}`;
      },
    )
    .join("\n");
  const primaryKeys = Object.entries(input.primaryKeys)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n") || "(none)";
  return `You are BigSet's extractorBuilder. Generate one reusable Playwright extractor for this dataset/page pattern.

Dataset:
- Name: ${input.datasetName ?? ""}
- Description: ${input.description ?? ""}
- Retrieval strategy: ${input.retrievalStrategy ?? ""}
- Source hint: ${input.sourceHint ?? ""}

Dataset columns:
${columns}

Primary key values for the representative row:
${primaryKeys}

Browser start URL:
${url}

Browser probe:
${summarizeEvidenceForPrompt(evidence)}

Requirements:
- Return only JavaScript. No Markdown.
- Define exactly: async function extract({ page, input, helpers }) { ... }
- Do not import anything.
- Do not use require, process, fs, child_process, fetch, eval, new Function, Node http/https/net modules, or direct database/network APIs.
- Use only the provided Playwright page, input, and helpers.
- The primary key values are arbitrary row input. Do not assume they are URLs.
- You may construct navigation URLs from input.primaryKeys, top-level primary key fields, input.sourceHint, input.urls, dataset name, or context. Example: a primary key like "tinyfish-io/bigset" may need page.goto(\`https://github.com/\${input.primaryKeys.repo_slug}\`).
- Navigate with page.goto(..., { waitUntil: "domcontentloaded" }) if needed. input.startUrl/input.url is only the browser start URL, not necessarily the row URL.
- Return an object: { data, sources, row_summary, how_found }.
- data must include every dataset column. Preserve primary key values from input.primaryKeys.
- Use "" for unknown values. Never fabricate.
- Returned values must be normalized to each column's type contract.
- If a column has validation_regex, the final returned value must match it after normalization. Use normalization_hint as the guide for converting page text to the canonical value.
- If a required selector/value is empty or does not match validation_regex, return "" for that field rather than guessing; BigSet will reject/repair failed validation.
- Prefer stable DOM selectors, JSON-LD, meta tags, tables, definition lists, and visible labels.
- The extractor must be reusable for other rows on the same site/page pattern.`;
}

function summarizeEvidenceForPrompt(evidence: PageEvidence): string {
  const candidates = Object.entries(evidence.candidates)
    .slice(0, 80)
    .map(([key, values]) => `- ${key}: ${values.slice(0, 3).join(" | ")}`)
    .join("\n");
  return `Final URL: ${evidence.finalUrl}
Title: ${evidence.title ?? ""}
Description: ${evidence.description ?? ""}

Candidate fields:
${candidates || "(none)"}

Visible text excerpt:
${evidence.bodyText.slice(0, 8_000)}`;
}

function summarizeEvidenceForStorage(evidence: PageEvidence): string {
  return [
    `url=${evidence.finalUrl}`,
    evidence.title ? `title=${evidence.title}` : undefined,
    evidence.description ? `description=${evidence.description}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
}

function sanitizeGeneratedScript(text: string): string {
  const fenced = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text)
    .trim()
    .replace(/\bexport\s+async\s+function\s+extract\b/, "async function extract")
    .replace(/\bexport\s+function\s+extract\b/, "function extract");
  rejectDangerousScript(raw);
  if (!/\basync\s+function\s+extract\s*\(/.test(raw) && !/\bfunction\s+extract\s*\(/.test(raw)) {
    throw new Error("generated extractor did not define function extract");
  }
  return raw;
}

function rejectDangerousScript(script: string): void {
  const dangerousPatterns = [
    /\bimport\s*(?:\(|[^("'])/i,
    /\brequire\s*\(/i,
    /\bprocess\b/i,
    /\bfs\b/i,
    /\bchild_process\b/i,
    /\bworker_threads\b/i,
    /\beval\s*\(/i,
    /\bnew\s+Function\b/i,
    /\bfetch\s*\(/i,
    /\bXMLHttpRequest\b/i,
    /\bWebSocket\b/i,
    /\bnode:(?:http|https|net)\b/i,
    /\bconvex\b/i,
  ];
  const match = dangerousPatterns.find((pattern) => pattern.test(script));
  if (match) {
    throw new Error(`generated extractor contains a blocked pattern: ${match}`);
  }
}

async function validateExtractorScript(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const raw = await runGeneratedExtractorScript(apiKey, input, url, script);
    const extraction = buildRowFromExtractorResult(input, url, raw);
    if (!hasExtractedNonPrimaryValue(extraction, input.columns)) {
      return { ok: false, reason: "extractor returned no non-primary values" };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runGeneratedExtractorScript(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
): Promise<GeneratedExtractorResult> {
  rejectDangerousScript(script);
  const session = await createTinyFishBrowserSession(apiKey, url, input.datasetId);
  const payload = JSON.stringify({
    cdpUrl: session.cdp_url,
    url,
    script,
    input: {
      ...input.primaryKeys,
      url,
      startUrl: url,
      primaryKeys: input.primaryKeys,
      urls: input.urls ?? [],
      columns: input.columns,
      datasetName: input.datasetName ?? "",
      description: input.description ?? "",
      retrievalStrategy: input.retrievalStrategy ?? "",
      sourceHint: input.sourceHint ?? "",
      context: input.context ?? "",
    },
    timeoutMs: EXTRACTOR_RUNNER_TIMEOUT_MS,
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", EXTRACTOR_RUNNER_SOURCE], {
      cwd: BACKEND_ROOT,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("generated extractor timed out"));
    }, EXTRACTOR_RUNNER_TIMEOUT_MS + 5_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > EXTRACTOR_SCRIPT_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        reject(new Error("generated extractor output limit exceeded"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `generated extractor exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as GeneratedExtractorResult);
      } catch (err) {
        reject(new Error(`generated extractor returned invalid JSON: ${err}`));
      }
    });
    child.stdin.end(payload);
  });
}

function buildRowFromExtractorResult(
  input: TryRowExtractorInput,
  url: string,
  result: GeneratedExtractorResult,
  existingData?: Record<string, unknown>,
): GenericExtraction {
  if (!result || typeof result !== "object" || !result.data || typeof result.data !== "object") {
    throw new Error("generated extractor did not return a data object");
  }

  const data: Record<string, ExtractedValue> = {};
  const extractedColumns: string[] = [];
  const missingColumns: string[] = [];
  const invalidColumns: string[] = [];

  for (const column of input.columns) {
    const pkValue = findPrimaryKeyValue(column.name, input.primaryKeys);
    if (pkValue !== undefined) {
      const value = coerceColumnValue(pkValue, column, url) ?? pkValue;
      const validationError = validateColumnValue(value, column);
      if (validationError) {
        throw new Error(`primary key "${column.name}" failed validation: ${validationError}`);
      }
      data[column.name] = value;
      extractedColumns.push(column.name);
      continue;
    }

    const rawValue = result.data[column.name];
    const value = coerceColumnValue(rawValueToExtractedValue(rawValue), column, url);
    if (value !== undefined) {
      const validationError = validateColumnValue(value, column);
      if (!validationError) {
        data[column.name] = value;
        extractedColumns.push(column.name);
        continue;
      }
      invalidColumns.push(`${column.name}: ${validationError}`);
    }

    if (existingData && existingData[column.name] !== undefined) {
      data[column.name] = normalizeStoredValue(existingData[column.name]);
    } else {
      data[column.name] = "";
    }
    missingColumns.push(column.name);
  }

  if (invalidColumns.length > 0) {
    throw new Error(
      `generated extractor returned values that failed validation: ${invalidColumns.join("; ")}`,
    );
  }

  const missingRequiredColumns = input.columns
    .filter((column) => columnRequiresValue(column) && missingColumns.includes(column.name))
    .map((column) => column.name);
  if (missingRequiredColumns.length > 0) {
    throw new Error(
      `generated extractor missed required columns: ${missingRequiredColumns.join(", ")}`,
    );
  }

  const sources = Array.isArray(result.sources)
    ? result.sources.filter((source): source is string => typeof source === "string" && isHttpUrl(source))
    : [];
  const summary = String(result.row_summary ?? result.rowSummary ?? "").trim().slice(0, 500);

  return {
    data,
    sources: sources.length > 0 ? sources : [url],
    rowSummary: summary || url,
    extractedColumns,
    missingColumns,
  };
}

function hasExtractedNonPrimaryValue(
  extraction: GenericExtraction,
  columns: PopulateColumn[],
): boolean {
  const pkColumns = new Set(
    columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
  );
  return extraction.extractedColumns.some((columnName) => !pkColumns.has(columnName));
}

function rawValueToExtractedValue(value: unknown): ExtractedValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (value == null) return undefined;
  return String(value);
}

function columnRequiresValue(column: PopulateColumn): boolean {
  return column.nullable === false;
}

function validateColumnValue(
  value: ExtractedValue,
  column: PopulateColumn,
): string | undefined {
  const pattern = column.validationRegex?.trim();
  if (!pattern) return undefined;

  const text = String(value).trim();
  if (!text) {
    return column.nullable === true ? undefined : "empty value";
  }

  let regex: RegExp;
  try {
    regex = compileValidationRegex(pattern);
  } catch (err) {
    return `invalid schema validation regex ${JSON.stringify(pattern)}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  if (!regex.test(text)) {
    return `value ${JSON.stringify(text).slice(0, 120)} does not match ${JSON.stringify(pattern)}`;
  }
  return undefined;
}

function compileValidationRegex(pattern: string): RegExp {
  const literal = pattern.match(/^\/([\s\S]*)\/([a-z]*)$/i);
  if (!literal) return new RegExp(pattern);
  const flags = Array.from(new Set(literal[2].replace(/[gy]/g, "").split(""))).join("");
  return new RegExp(literal[1], flags);
}

function siteKeyForUrl(value: string): string {
  try {
    const url = new URL(value);
    const firstPathSegment = url.pathname.split("/").filter(Boolean)[0];
    return [url.hostname.toLowerCase(), firstPathSegment].filter(Boolean).join("/");
  } catch {
    return "invalid-url";
  }
}

function siteKeyForInput(input: TryRowExtractorInput, browserStartUrl: string): string {
  const sourceUrl = [
    input.sourceHint,
    ...(input.urls ?? []),
    ...Object.values(input.primaryKeys),
  ]
    .map(coerceHttpUrl)
    .find((value): value is string => Boolean(value));
  return siteKeyForUrl(sourceUrl ?? browserStartUrl);
}

function hashColumns(columns: PopulateColumn[]): string {
  const payload = columns.map((column) => ({
    name: column.name,
    type: column.type,
    description: column.description ?? "",
    isPrimaryKey: Boolean(column.isPrimaryKey),
    nullable: column.nullable,
    validationRegex: column.validationRegex ?? "",
    normalizationHint: column.normalizationHint ?? "",
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function changedColumnNames(
  nextRow: Record<string, ExtractedValue>,
  existingData: Record<string, unknown>,
  columns: PopulateColumn[],
): string[] {
  return columns
    .filter((column) => !valuesEqualForColumn(nextRow[column.name], existingData[column.name], column))
    .map((column) => column.name);
}

function valuesEqualForColumn(
  nextValue: ExtractedValue | undefined,
  existingValue: unknown,
  column: PopulateColumn,
): boolean {
  if (nextValue === undefined) return existingValue === undefined || existingValue === "";

  switch (column.type) {
    case "number": {
      const nextNumber =
        typeof nextValue === "number"
          ? nextValue
          : Number(String(nextValue ?? "").replace(/,/g, ""));
      const existingNumber =
        typeof existingValue === "number"
          ? existingValue
          : Number(String(existingValue ?? "").replace(/,/g, ""));
      return (
        Number.isFinite(nextNumber) &&
        Number.isFinite(existingNumber) &&
        existingNumber === nextNumber
      );
    }
    case "boolean":
      if (typeof existingValue === "boolean") return existingValue === nextValue;
      if (/^(true|yes)$/i.test(String(existingValue))) return nextValue === true;
      if (/^(false|no)$/i.test(String(existingValue))) return nextValue === false;
      return String(existingValue ?? "").trim() === String(nextValue).trim();
    case "date": {
      const nextDate = new Date(String(nextValue));
      const existingDate = new Date(String(existingValue ?? ""));
      return (
        Number.isFinite(nextDate.getTime()) &&
        Number.isFinite(existingDate.getTime()) &&
        nextDate.getTime() === existingDate.getTime()
      );
    }
    case "url":
    case "text":
      return String(existingValue ?? "").trim() === String(nextValue).trim();
  }
}

function findPrimaryKeyValue(
  columnName: string,
  primaryKeys: Record<string, string>,
): string | undefined {
  if (primaryKeys[columnName]) return primaryKeys[columnName];
  const normalizedColumn = normalizeFieldName(columnName);
  const entry = Object.entries(primaryKeys).find(
    ([key]) => normalizeFieldName(key) === normalizedColumn,
  );
  return entry?.[1];
}

function coerceColumnValue(
  value: string | number | boolean | undefined,
  column: PopulateColumn,
  baseUrl: string,
): ExtractedValue | undefined {
  if (value === undefined || value === "") return undefined;
  switch (column.type) {
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      return parseCompactNumber(String(value));
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (/^(true|yes|available|in stock|active)$/i.test(String(value).trim())) return true;
      if (/^(false|no|unavailable|out of stock|inactive)$/i.test(String(value).trim())) {
        return false;
      }
      return undefined;
    case "url":
      return normalizeMaybeRelativeUrl(String(value), baseUrl);
    case "date": {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    case "text":
      return String(value).trim();
  }
}

function normalizeMaybeRelativeUrl(
  value: string,
  baseUrl: string,
): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStoredValue(value: unknown): ExtractedValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return String(value ?? "");
}

function parseCompactNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, "");
  const match =
    normalized.match(/[$€£]?\s*([\d]+(?:\.\d+)?)\s*([kmb])?/i) ??
    normalized.match(/([\d]+(?:\.\d+)?)/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return Math.round(base * multiplier * 100) / 100;
}

function normalizeFieldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
