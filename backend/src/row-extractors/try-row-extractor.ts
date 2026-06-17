import { chromium, type Browser, type Page } from "playwright-core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { getSignal } from "../abort-registry.js";
import { convex, internal } from "../convex.js";
import { FETCH_TIMEOUT_MS } from "../fetch-timeout.js";
import {
  getTinyFishApiKey,
  requireLlmProviderConfig,
  tinyFishHeaders,
} from "../local-credentials.js";
import {
  createLanguageModel,
} from "../config/llm.js";
import { AGENT_MAX_OUTPUT_TOKENS } from "../config/agent-output-tokens.js";
import type { CodificationProfile, PopulateColumn } from "../pipeline/populate.js";
import {
  normalizeCodificationProfile,
  shouldAttemptCodification,
} from "../pipeline/codification.js";
import { DEFAULT_MODEL_IDS } from "../config/models.js";

type ExtractorStatus = "inserted" | "updated" | "unchanged" | "miss" | "failed";
type ExtractedValue = string | number | boolean;
type ColumnExtractionStatus =
  | "extracted"
  | "derived"
  | "not_present_on_page"
  | "blocked"
  | "ambiguous"
  | "validation_failed"
  | "fallback_needed"
  | "missing";

interface ColumnStatus {
  status: ColumnExtractionStatus;
  reason?: string;
}

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
  codificationProfile?: CodificationProfile;
  browserAttempts?: number;
  extractorBuilderModel?: string;
  abortSignal?: AbortSignal;
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

export interface RowExtractorDraftResult {
  status: "extracted" | "miss" | "failed";
  reason: string;
  data?: Record<string, ExtractedValue>;
  rowSummary?: string;
  sources?: string[];
  cellSources?: Record<string, string[]>;
  extractedColumns?: string[];
  missingColumns?: string[];
  requiredMissingColumns?: string[];
  optionalMissingColumns?: string[];
  columnStatuses?: Record<string, ColumnStatus>;
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
  cellSources: Record<string, string[]>;
  extractedColumns: string[];
  missingColumns: string[];
  requiredMissingColumns: string[];
  optionalMissingColumns: string[];
  columnStatuses: Record<string, ColumnStatus>;
}

interface GeneratedExtractorResult {
  data?: Record<string, unknown>;
  sources?: unknown;
  cell_sources?: unknown;
  cellSources?: unknown;
  row_summary?: unknown;
  rowSummary?: unknown;
  how_found?: unknown;
  howFound?: unknown;
  column_status?: unknown;
  columnStatus?: unknown;
}

interface DetailedExtractorTestResult {
  ok: boolean;
  reason: string;
  extraction?: GenericExtraction;
}

interface AgenticExtractorBuildResult {
  script: string;
  probeSummary: string;
}

interface CachedExtractorScript {
  script: string;
  updatedAt: number;
}

interface RuntimeRepairResult {
  script: string;
  cachedExtractor?: CachedExtractorScript;
}

interface ExtractorSmokeTestCase {
  input: TryRowExtractorInput;
  url: string;
  source: "memory" | "persisted";
}

const BROWSER_TIMEOUT_MS = 45_000;
const CDP_CONNECT_TIMEOUT_MS = 45_000;
const DEFAULT_BROWSER_ATTEMPTS = 2;
const TRANSIENT_BROWSER_ATTEMPTS = 2;
const EXTRACTOR_RUNNER_TIMEOUT_MS = 60_000;
const EXTRACTOR_SCRIPT_OUTPUT_LIMIT = 256_000;
const EXTRACTOR_BUILDER_MAX_STEPS = 80;
const EXTRACTOR_REPAIR_MAX_STEPS = 24;
const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GENERIC_EXTRACTOR_HOW_FOUND =
  "Opened the row target with TinyFish Browser and ran the dataset's sandboxed browser extractor.";
const GENERIC_REFRESH_HOW_FOUND =
  "Refreshed the row target with TinyFish Browser and ran the dataset's sandboxed browser extractor.";
const inFlightExtractorBuilds = new Map<string, Promise<CachedExtractorScript>>();
const inFlightExtractorRepairs = new Map<string, Promise<RuntimeRepairResult>>();
const extractorSmokeTests = new Map<string, ExtractorSmokeTestCase>();
const EXTRACTOR_RUNNER_SOURCE = `
import { chromium } from "playwright-core";
import { Bash, InMemoryFs } from "just-bash";
import dns from "node:dns/promises";
import net from "node:net";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const browser = await chromium.connectOverCDP(payload.cdpUrl, { timeout: 45000 });
let timeout;
let abortController;

const MAX_SELECTOR_LENGTH = 2000;
const MAX_COMMAND_OUTPUT_CHARS = 256000;
const MAX_HTTP_RESPONSE_BYTES = 20 * 1024 * 1024;
const PUBLIC_HTTP_TIMEOUT_MS = 30000;
const PUBLIC_HTTP_MAX_REDIRECTS = 10;
const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTTP_METHODS = new Set(["GET", "HEAD"]);
const EXTRACTOR_COMMANDS = [
  "cat",
  "printf",
  "echo",
  "grep",
  "fgrep",
  "egrep",
  "rg",
  "sed",
  "awk",
  "sort",
  "uniq",
  "comm",
  "cut",
  "paste",
  "tr",
  "rev",
  "nl",
  "fold",
  "expand",
  "unexpand",
  "strings",
  "split",
  "column",
  "join",
  "head",
  "tail",
  "wc",
  "xargs",
  "jq",
  "yq",
  "xan",
  "sqlite3",
  "base64",
  "gzip",
  "gunzip",
  "zcat",
  "tar",
  "file",
  "find",
  "ls",
  "mkdir",
  "rmdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "pwd",
  "dirname",
  "basename",
  "tee",
  "date",
  "seq",
  "expr",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "true",
  "false",
  "sleep",
  "timeout",
  "env",
  "printenv",
  "which",
  "html-to-markdown",
];

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

const helpersPython = [
  "import json, re, sys, urllib.parse",
  "",
  "def clean_text(value):",
  "    return re.sub(r'\\\\s+', ' ', str(value or '')).strip()",
  "",
  "def parse_compact_number(value):",
  "    text = str(value or '').replace(',', '')",
  "    match = re.search(r'[$€£]?\\\\s*([0-9]+(?:\\\\.[0-9]+)?)\\\\s*([kmb])?', text, re.I) or re.search(r'([0-9]+(?:\\\\.[0-9]+)?)', text)",
  "    if not match:",
  "        return None",
  "    base = float(match.group(1))",
  "    suffix = (match.group(2) or '').lower() if len(match.groups()) > 1 else ''",
  "    mult = {'k': 1000, 'm': 1000000, 'b': 1000000000}.get(suffix, 1)",
  "    value = round(base * mult, 2)",
  "    return int(value) if value.is_integer() else value",
  "",
  "parse_number = parse_compact_number",
  "parse_price = parse_compact_number",
  "parse_rating = parse_compact_number",
  "",
  "def absolute_url(value, base=None):",
  "    return urllib.parse.urljoin(base or '', str(value or ''))",
  "",
].join("\\n");

function ok(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { stdout: "", stderr: message + "\\n", exitCode: 1 };
}

function trimOutput(value, limit = MAX_COMMAND_OUTPUT_CHARS) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(0, limit) : text;
}

function jsonOutput(value) {
  return ok(trimOutput(JSON.stringify(value)) + "\\n");
}

function textOutput(value) {
  return ok(trimOutput(value) + "\\n");
}

function arg(args, index, name) {
  const value = args[index];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(name + " is required");
  }
  return value;
}

function parseLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function ensureSelector(selector) {
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error("selector is too long");
  }
  return selector;
}

function command(name, execute) {
  return {
    name,
    trusted: true,
    execute: async (args, ctx) => {
      try {
        return await execute(args, ctx);
      } catch (err) {
        return fail(err);
      }
    },
  };
}

async function firstLocator(page, selector) {
  return page.locator(ensureSelector(selector)).first();
}

function pageCommands(page) {
  return [
    command("page-goto", async (args) => {
      const target = coerceHttpUrl(args[0] || payload.url);
      const response = await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      const status = response?.status();
      if (typeof status === "number" && status >= 400) {
        throw new Error("page-goto returned HTTP " + status + ": " + page.url());
      }
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      return textOutput(page.url());
    }),
    command("page-url", async () => textOutput(page.url())),
    command("page-title", async () => textOutput(cleanText(await page.title()))),
    command("page-text", async (args) => {
      const locator = await firstLocator(page, arg(args, 0, "selector"));
      return textOutput(cleanText(await locator.textContent({ timeout: 10000 }).catch(() => "")));
    }),
    command("page-texts", async (args) => {
      const selector = ensureSelector(arg(args, 0, "selector"));
      const limit = parseLimit(args[1], 50, 200);
      const values = await page.locator(selector).evaluateAll(
        (elements, max) => elements
          .slice(0, max)
          .map((element) => String(element.textContent ?? "").replace(/\\s+/g, " ").trim())
          .filter(Boolean),
        limit,
      );
      return jsonOutput(values);
    }),
    command("page-attr", async (args) => {
      const locator = await firstLocator(page, arg(args, 0, "selector"));
      const name = arg(args, 1, "attribute");
      return textOutput(cleanText(await locator.getAttribute(name, { timeout: 10000 }).catch(() => "")));
    }),
    command("page-count", async (args) => {
      const selector = ensureSelector(arg(args, 0, "selector"));
      return textOutput(String(await page.locator(selector).count()));
    }),
    command("page-exists", async (args) => {
      const selector = ensureSelector(arg(args, 0, "selector"));
      return textOutput((await page.locator(selector).count()) > 0 ? "true" : "false");
    }),
    command("page-wait", async (args) => {
      const selector = ensureSelector(arg(args, 0, "selector"));
      const timeoutMs = parseLimit(args[1], 10000, 30000);
      await page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
      return textOutput("ok");
    }),
    command("page-click", async (args) => {
      const locator = await firstLocator(page, arg(args, 0, "selector"));
      await locator.click({ timeout: 10000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      return textOutput(page.url());
    }),
    command("page-fill", async (args) => {
      const locator = await firstLocator(page, arg(args, 0, "selector"));
      await locator.fill(args[1] ?? "", { timeout: 10000 });
      return textOutput("ok");
    }),
    command("page-meta", async (args) => {
      const name = arg(args, 0, "name");
      const value = await page.evaluate((metaName) => {
        const normalized = String(metaName || "").toLowerCase();
        if (normalized === "canonical") {
          return document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
        }
        const wanted = String(metaName || "").toLowerCase();
        for (const element of Array.from(document.querySelectorAll("meta"))) {
          const key = (
            element.getAttribute("name") ||
            element.getAttribute("property") ||
            ""
          ).toLowerCase();
          if (key === wanted) return element.getAttribute("content") || "";
        }
        return "";
      }, name);
      return textOutput(cleanText(value));
    }),
    command("page-jsonld", async () => {
      const values = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map((script) => {
            try {
              return JSON.parse(script.textContent || "");
            } catch {
              return undefined;
            }
          })
          .filter((value) => value !== undefined);
      });
      return jsonOutput(values);
    }),
    command("page-links", async (args) => {
      const limit = parseLimit(args[0], 100, 500);
      const values = await page.evaluate((max) => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        return Array.from(document.querySelectorAll("a[href]"))
          .slice(0, max)
          .map((element) => ({
            text: clean(element.textContent || element.getAttribute("aria-label") || ""),
            href: element.href,
          }))
          .filter((link) => /^https?:\\/\\//i.test(link.href));
      }, limit);
      return jsonOutput(values);
    }),
    command("page-visible-text", async (args) => {
      const limit = parseLimit(args[0], 60000, 200000);
      const text = await page.evaluate((max) => {
        return String(document.body?.innerText || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, max);
      }, limit);
      return textOutput(text);
    }),
  ];
}

function coerceHttpUrl(value) {
  const url = new URL(String(value || ""), payload.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  return url.toString();
}

async function assertPublicHttpUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("curl only supports http(s) URLs");
  }
  const host = normalizeHost(url.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal" || host.endsWith(".internal")) {
    throw new Error("private/internal host is not allowed: " + host);
  }
  if (net.isIP(host) === 0 && !host.includes(".")) {
    throw new Error("single-label host is not allowed: " + host);
  }
  if (isPrivateAddress(host)) {
    throw new Error("private/internal IP is not allowed: " + host);
  }
  if (net.isIP(host) === 0) {
    const records = await dns.lookup(host, { all: true });
    for (const record of records) {
      if (isPrivateAddress(record.address)) {
        throw new Error("host resolves to a private/internal IP: " + host);
      }
    }
  }
  return url.toString();
}

function normalizeHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\\[(.*)\\]$/, "$1");
}

function isPrivateAddress(address) {
  const normalized = normalizeHost(address);
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isPrivateAddress(mapped);
  }
  return false;
}

async function publicFetch(rawUrl, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new Error("HTTP method not allowed in extractor sandbox: " + method);
  }

  let current = await assertPublicHttpUrl(rawUrl);
  const followRedirects = options.followRedirects ?? true;
  const timeoutMs = Math.min(Number(options.timeoutMs) || PUBLIC_HTTP_TIMEOUT_MS, PUBLIC_HTTP_TIMEOUT_MS);

  for (let redirects = 0; ; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current, {
        method,
        headers: options.headers,
        redirect: "manual",
        signal: controller.signal,
      });

      if (followRedirects && HTTP_REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) return await responseToFetchResult(response, current, method);
        if (redirects >= PUBLIC_HTTP_MAX_REDIRECTS) {
          throw new Error("too many redirects");
        }
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }

      return await responseToFetchResult(response, current, method);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function responseToFetchResult(response, url, method) {
  const headers = Object.create(null);
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error("HTTP response too large");
  }
  const body = method === "HEAD"
    ? new Uint8Array()
    : new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error("HTTP response too large");
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url,
  };
}

function parseExtractorOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error("extractor script produced no JSON output");
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new Error("extractor script did not print a JSON object on stdout");
}

try {
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();
  const response = await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const status = response?.status();
  if (typeof status === "number" && status >= 400) {
    throw new Error("start URL returned HTTP " + status + ": " + page.url());
  }
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const sandbox = new Bash({
    fs: new InMemoryFs({
      "/input.json": JSON.stringify(payload.input, null, 2),
      "/schema.json": JSON.stringify(payload.input.columns ?? [], null, 2),
      "/helpers.py": helpersPython,
    }),
    cwd: "/home/user",
    env: {
      START_URL: payload.url,
      INPUT_JSON: "/input.json",
      SCHEMA_JSON: "/schema.json",
      PYTHONPATH: "/",
    },
    commands: EXTRACTOR_COMMANDS,
    customCommands: pageCommands(page),
    fetch: publicFetch,
    python: true,
    javascript: false,
    defenseInDepth: true,
    executionLimits: {
      maxCallDepth: 100,
      maxCommandCount: 20000,
      maxLoopIterations: 100000,
      maxAwkIterations: 100000,
      maxSedIterations: 100000,
    },
  });

  abortController = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new Error("extract timed out"));
    }, payload.timeoutMs);
  });
  const execResult = await Promise.race([
    sandbox.exec(payload.script, {
      rawScript: true,
      replaceEnv: true,
      env: {
        START_URL: payload.url,
        INPUT_JSON: "/input.json",
        SCHEMA_JSON: "/schema.json",
        PYTHONPATH: "/",
      },
      signal: abortController.signal,
    }),
    timeoutPromise,
  ]);
  if (execResult.exitCode !== 0) {
    throw new Error((execResult.stderr || "extractor script failed").trim());
  }
  const result = parseExtractorOutput(execResult.stdout);
  process.stdout.write(JSON.stringify(result ?? {}));
} finally {
  if (timeout) clearTimeout(timeout);
  if (abortController) abortController.abort();
  await browser.close().catch(() => {});
}
`;

class NonRepairableExtractorFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRepairableExtractorFailure";
  }
}

function abortSignalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Run was stopped", "AbortError");
}

function runWasAborted(datasetId: string, abortSignal?: AbortSignal): boolean {
  return getSignal(datasetId)?.aborted === true || abortSignal?.aborted === true;
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || /Run was stopped|AbortError/i.test(err.message);
}

function throwIfAbortSignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = abortSignalReason(signal);
  if (reason instanceof Error) throw reason;
  throw new DOMException(String(reason), "AbortError");
}

function throwIfRunAborted(datasetId: string, abortSignal?: AbortSignal): void {
  const runSignal = getSignal(datasetId);
  if (runSignal?.aborted) {
    const reason = abortSignalReason(runSignal);
    if (reason instanceof Error) throw reason;
    throw new DOMException(String(reason), "AbortError");
  }
  throwIfAbortSignalAborted(abortSignal);
}

function isTransientBrowserFailure(reason: string): boolean {
  return /browserType\.connectOverCDP|WebSocket error|getaddrinfo|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|net::ERR_TUNNEL_CONNECTION_FAILED|Target page, context or browser has been closed/i.test(
    reason,
  );
}

function isHttpSourceFailure(reason: string): boolean {
  return /start URL returned HTTP \d{3}:|net::ERR_HTTP_RESPONSE_CODE_FAILURE|TinyFish Browser returned HTTP/i.test(
    reason,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tryRowExtractor(
  input: TryRowExtractorInput,
): Promise<TryRowExtractorResult> {
  const draft = await tryRowExtractorDraft(input);
  if (draft.status !== "extracted") {
    return {
      status: draft.status,
      reason: draft.reason,
      rowSummary: draft.rowSummary,
      sources: draft.sources,
    };
  }

  if ((draft.missingColumns ?? []).length > 0) {
    return {
      status: "miss",
      reason: `browser extractor left unresolved columns for fallback: ${(draft.missingColumns ?? []).join(", ")}`,
      rowSummary: draft.rowSummary,
      sources: draft.sources,
    };
  }

  try {
    await convex.mutation(internal.datasetRows.insert, {
      datasetId: input.datasetId,
      data: draft.data ?? {},
      sources: draft.sources,
      cellSources: draft.cellSources,
      rowSummary: draft.rowSummary,
      howFound: GENERIC_EXTRACTOR_HOW_FOUND,
    });

    return {
      status: "inserted",
      reason: `Inserted by generic browser extractor (${(draft.extractedColumns ?? []).join(", ")})`,
      rowSummary: draft.rowSummary,
      sources: draft.sources,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof NonRepairableExtractorFailure) {
      return {
        status: "miss",
        reason: `browser extractor skipped repair for row-level/source issue: ${msg}`,
      };
    }
    if (/duplicate/i.test(msg)) {
      return {
        status: "miss",
        reason: `${msg} Move on to the next entity.`,
      };
    }
    return { status: "failed", reason: msg };
  }
}

export async function tryRowExtractorDraft(
  input: TryRowExtractorInput,
): Promise<RowExtractorDraftResult> {
  throwIfRunAborted(input.datasetId, input.abortSignal);
  const codificationProfile = normalizeCodificationProfile(input.codificationProfile, input);
  if (!shouldAttemptCodification(codificationProfile, input)) {
    return {
      status: "miss",
      reason: `codification profile is ${codificationProfile.mode}: ${codificationProfile.reason}`,
    };
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

    return {
      status: "extracted",
      reason:
        extraction.missingColumns.length > 0
          ? `Browser extractor filled ${extraction.extractedColumns.length} columns and left ${extraction.missingColumns.length} for fallback`
          : `Browser extractor filled all ${extraction.extractedColumns.length} columns`,
      data: extraction.data,
      rowSummary: extraction.rowSummary,
      sources: extraction.sources,
      cellSources: extraction.cellSources,
      extractedColumns: extraction.extractedColumns,
      missingColumns: extraction.missingColumns,
      requiredMissingColumns: extraction.requiredMissingColumns,
      optionalMissingColumns: extraction.optionalMissingColumns,
      columnStatuses: extraction.columnStatuses,
    };
  } catch (err) {
    if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof NonRepairableExtractorFailure) {
      return {
        status: "miss",
        reason: `browser extractor skipped repair for row-level/source issue: ${msg}`,
      };
    }
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
  throwIfRunAborted(input.datasetId, input.abortSignal);
  const codificationProfile = normalizeCodificationProfile(input.codificationProfile, input);
  if (!shouldAttemptCodification(codificationProfile, input)) {
    return {
      status: "miss",
      reason: `codification profile is ${codificationProfile.mode}: ${codificationProfile.reason}`,
    };
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
    if (extraction.missingColumns.length > 0) {
      return {
        status: "miss",
        reason: `browser extractor left unresolved columns during refresh: ${extraction.missingColumns.join(", ")}`,
        rowSummary: extraction.rowSummary,
        sources: extraction.sources,
      };
    }
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
      cellSources: extraction.cellSources,
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
    if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof NonRepairableExtractorFailure) {
      return {
        status: "miss",
        reason: `browser extractor skipped repair for row-level/source issue: ${msg}`,
      };
    }
    return { status: "failed", reason: msg };
  }
}

function initialBrowserUrl(input: TryRowExtractorInput): string | undefined {
  const explicitUrl = browserStartUrlCandidates(input)
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

function browserStartUrlCandidates(input: TryRowExtractorInput): Array<string | undefined> {
  return uniqueCandidateValues([
    ...Object.values(input.primaryKeys),
    ...(input.urls ?? []),
    ...renderCodificationTemplateUrls(input),
    ...extractHttpUrls(input.sourceHint),
    ...extractHttpUrls(input.context),
    input.sourceHint,
  ]);
}

function renderCodificationTemplateUrls(input: TryRowExtractorInput): string[] {
  const urls: string[] = [];
  for (const family of input.codificationProfile?.families ?? []) {
    if (!family.urlTemplate) continue;
    const rendered = renderUrlTemplate(family.urlTemplate, input.primaryKeys);
    if (rendered) urls.push(rendered);
  }
  return urls;
}

function renderUrlTemplate(
  template: string,
  primaryKeys: Record<string, string>,
): string | undefined {
  let missing = false;
  const rendered = template.replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (match: string, key: string, offset: number) => {
      const value = findPrimaryKeyValue(key, primaryKeys)?.trim();
      if (!value) {
        missing = true;
        return "";
      }
      return encodeTemplateValue(template, offset, value);
    },
  );
  return missing ? undefined : rendered;
}

function encodeTemplateValue(template: string, placeholderOffset: number, value: string): string {
  if (placeholderIsInQueryOrHash(template, placeholderOffset)) {
    return encodeURIComponent(value);
  }
  return value.split("/").map(encodeURIComponent).join("/");
}

function placeholderIsInQueryOrHash(template: string, placeholderOffset: number): boolean {
  const queryIndex = template.indexOf("?");
  const hashIndex = template.indexOf("#");
  const boundaryIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  return boundaryIndexes.length > 0 && Math.min(...boundaryIndexes) < placeholderOffset;
}

function extractHttpUrls(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/https?:\/\/[^\s)>"']+/gi)].map((match) => normalizeUrl(match[0]));
}

function uniqueCandidateValues(values: Array<string | undefined>): Array<string | undefined> {
  const seen = new Set<string>();
  const output: Array<string | undefined> = [];
  for (const value of values) {
    const key = value?.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
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

  const siteKey = siteKeyForInput(input, url);
  const cachedExtractor = await getOrBuildExtractorScript(apiKey, input, url);
  const script = cachedExtractor.script;
  throwIfRunAborted(input.datasetId, input.abortSignal);
  const attempts = normalizedBrowserAttempts(input.browserAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(
        `[row_extractor] running generated sandboxed browser extractor for ${siteKey} attempt=${attempt}/${attempts}`,
      );
      const raw = await runGeneratedExtractorScript(apiKey, input, url, script);
      const extraction = buildRowFromExtractorResult(input, url, raw, existingData);
      const qualityIssue = extractorQualityIssue(extraction, input.columns);
      if (qualityIssue && isRowLevelQualityIssue(qualityIssue)) {
        console.warn(
          `[row_extractor] generated extractor produced row-level partial result for ${siteKey}; skipping repair: ${qualityIssue}`,
        );
        return extraction;
      }
      if (qualityIssue) throw new Error(qualityIssue);
      rememberExtractorSmokeTest(input, url);
      return extraction;
    } catch (err) {
      lastError = err;
      if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
        throw err;
      }
      if (runWasAborted(input.datasetId, input.abortSignal) || attempt === attempts) break;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[row_extractor] Browser attempt ${attempt}/${attempts} failed; retrying: ${msg}`,
      );
    }
  }

  throwIfRunAborted(input.datasetId, input.abortSignal);
  const failure = lastError instanceof Error ? lastError.message : String(lastError);
  if (isNonRepairableRuntimeFailure(failure)) {
    console.warn(
      `[row_extractor] generated extractor failed with non-repairable browser/source issue for ${siteKey}; skipping repair: ${failure}`,
    );
    throw new NonRepairableExtractorFailure(failure);
  }

  let extractorToMarkFailed = cachedExtractor;
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
    if (repaired.cachedExtractor) {
      extractorToMarkFailed = repaired.cachedExtractor;
    }
    console.log(`[row_extractor] running repaired sandboxed browser extractor for ${siteKey}`);
    const raw = await runGeneratedExtractorScript(apiKey, input, url, repaired.script);
    const extraction = buildRowFromExtractorResult(input, url, raw, existingData);
    const qualityIssue = extractorQualityIssue(extraction, input.columns);
    if (qualityIssue) throw new Error(qualityIssue);
    rememberExtractorSmokeTest(input, url);
    return extraction;
  } catch (repairErr) {
    if (isAbortLikeError(repairErr) && runWasAborted(input.datasetId, input.abortSignal)) {
      throw repairErr;
    }
    const repairMsg = repairErr instanceof Error ? repairErr.message : String(repairErr);
    if (!isTransientBrowserFailure(repairMsg) && !isHttpSourceFailure(repairMsg)) {
      const markedFailed = await markExtractorFailed(
        input,
        url,
        extractorToMarkFailed,
        repairMsg,
      );
      console.warn(
        markedFailed
          ? `[row_extractor] repair failed; marked cached extractor failed for ${siteKey}: ${repairMsg}`
          : `[row_extractor] repair failed; skipped stale cached extractor failure for ${siteKey}: ${repairMsg}`,
      );
    } else {
      console.warn(
        `[row_extractor] repair failed with transient/source issue; keeping cache state unchanged for ${siteKey}: ${repairMsg}`,
      );
    }
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
): Promise<CachedExtractorScript> {
  const siteKey = siteKeyForInput(input, url);
  const columnsHash = hashColumns(input.columns);
  const buildKey = extractorBuildKey(input.datasetId, siteKey, columnsHash);
  const existing = (await convex.query(internal.datasetExtractors.getActive, {
    datasetId: input.datasetId,
    siteKey,
    columnsHash,
  })) as { script?: string; updatedAt?: number } | null;
  if (existing?.script && typeof existing.updatedAt === "number") {
    console.log(`[row_extractor] using cached generated sandboxed browser extractor for ${siteKey}`);
    return { script: existing.script, updatedAt: existing.updatedAt };
  }

  const inFlightBuild = inFlightExtractorBuilds.get(buildKey);
  if (inFlightBuild) {
    console.log(`[row_extractor] waiting for in-flight extractor build for ${siteKey}`);
    return await inFlightBuild;
  }

  const buildPromise = buildAndPersistExtractorScript(apiKey, input, url, siteKey, columnsHash)
    .finally(() => {
      inFlightExtractorBuilds.delete(buildKey);
    });
  inFlightExtractorBuilds.set(buildKey, buildPromise);
  return await buildPromise;
}

async function markExtractorFailed(
  input: TryRowExtractorInput,
  url: string,
  extractor: CachedExtractorScript,
  error: string,
): Promise<boolean> {
  const siteKey = siteKeyForInput(input, url);
  const columnsHash = hashColumns(input.columns);
  try {
    const markedId = await convex.mutation(internal.datasetExtractors.markFailed, {
      datasetId: input.datasetId,
      siteKey,
      columnsHash,
      script: extractor.script,
      updatedAt: extractor.updatedAt,
      error,
    });
    return Boolean(markedId);
  } catch (err) {
    console.warn(
      `[row_extractor] failed to mark cached extractor failed for ${siteKey}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

async function buildAndPersistExtractorScript(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  siteKey: string,
  columnsHash: string,
): Promise<CachedExtractorScript> {
  const modelSlug = input.extractorBuilderModel ?? DEFAULT_MODEL_IDS.EXTRACTOR_BUILDER;
  const built = await buildExtractorScriptWithAgent(apiKey, input, url, modelSlug);
  const script = built.script;
  const validation = await validateExtractorScript(apiKey, input, url, script);
  if (validation.ok) {
    const stored = (await convex.mutation(internal.datasetExtractors.upsert, {
      datasetId: input.datasetId,
      siteKey,
      columnsHash,
      script,
      model: modelSlug,
      probeSummary: built.probeSummary,
    })) as { updatedAt: number };
    return { script, updatedAt: stored.updatedAt };
  }

  if (isNonRepairableValidationFailure(validation.reason)) {
    throw new NonRepairableExtractorFailure(validation.reason);
  }

  const repaired = await buildExtractorScriptWithAgent(
    apiKey,
    input,
    url,
    modelSlug,
    {
      previousScript: script,
      failure: validation.reason,
    },
  );
  const repairedValidation = await validateExtractorScript(apiKey, input, url, repaired.script);
  if (!repairedValidation.ok) {
    if (isNonRepairableValidationFailure(repairedValidation.reason)) {
      throw new NonRepairableExtractorFailure(repairedValidation.reason);
    }
    throw new Error(`generated extractor failed validation: ${repairedValidation.reason}`);
  }

  const stored = (await convex.mutation(internal.datasetExtractors.upsert, {
    datasetId: input.datasetId,
    siteKey,
    columnsHash,
    script: repaired.script,
    model: modelSlug,
    probeSummary: repaired.probeSummary,
  })) as { updatedAt: number };
  return { script: repaired.script, updatedAt: stored.updatedAt };
}

function isNonRepairableValidationFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  return isTransientBrowserFailure(reason) || isHttpSourceFailure(reason);
}

function extractorBuildKey(
  datasetId: string,
  siteKey: string,
  columnsHash: string,
): string {
  return `${datasetId}:${siteKey}:${columnsHash}`;
}

function extractorBuildKeyForInput(input: TryRowExtractorInput, url: string): string {
  return extractorBuildKey(
    input.datasetId,
    siteKeyForInput(input, url),
    hashColumns(input.columns),
  );
}

function rememberExtractorSmokeTest(input: TryRowExtractorInput, url: string): void {
  extractorSmokeTests.set(extractorBuildKeyForInput(input, url), {
    input: cloneSmokeTestInput(input),
    url,
    source: "memory",
  });
}

async function getExtractorSmokeTest(
  input: TryRowExtractorInput,
  url: string,
): Promise<ExtractorSmokeTestCase | undefined> {
  const key = extractorBuildKeyForInput(input, url);
  const memoryCase = extractorSmokeTests.get(key);
  if (memoryCase && !samePrimaryKeys(memoryCase.input.primaryKeys, input.primaryKeys)) {
    return memoryCase;
  }

  const rows = (await convex.query(internal.datasetRows.listInternal, {
    datasetId: input.datasetId,
  })) as Array<{
    _id?: string;
    data?: Record<string, unknown>;
    sources?: string[];
    rowSummary?: string;
    howFound?: string;
  }>;

  const currentRowId = "rowId" in input ? input.rowId : undefined;
  for (const row of rows) {
    if (currentRowId && row._id === currentRowId) continue;
    if (!isBrowserExtractedRow(row.howFound)) continue;
    if (!row.data || !storedRowHasCompleteValues(row.data, input.columns)) continue;

    const primaryKeys = primaryKeysFromStoredRow(row.data, input.columns);
    if (Object.keys(primaryKeys).length === 0) continue;
    if (samePrimaryKeys(primaryKeys, input.primaryKeys)) continue;

    const smokeInput = cloneSmokeTestInput({
      ...input,
      primaryKeys,
      urls: row.sources,
      context: [row.rowSummary, row.howFound].filter(Boolean).join("\n"),
    });
    const smokeUrl = initialBrowserUrl(smokeInput) ?? url;
    return { input: smokeInput, url: smokeUrl, source: "persisted" };
  }

  return undefined;
}

function cloneSmokeTestInput(input: TryRowExtractorInput): TryRowExtractorInput {
  return {
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    description: input.description,
    columns: input.columns,
    primaryKeys: { ...input.primaryKeys },
    urls: input.urls ? [...input.urls] : undefined,
    context: input.context,
    retrievalStrategy: input.retrievalStrategy,
    sourceHint: input.sourceHint,
    codificationProfile: input.codificationProfile,
    browserAttempts: input.browserAttempts,
    extractorBuilderModel: input.extractorBuilderModel,
  };
}

function isBrowserExtractedRow(howFound: string | undefined): boolean {
  return Boolean(howFound && /generated (?:Playwright|sandboxed browser) extractor/i.test(howFound));
}

function storedRowHasCompleteValues(
  data: Record<string, unknown>,
  columns: PopulateColumn[],
): boolean {
  return columns.every((column) => {
    const value = normalizeStoredValue(data[column.name]);
    return hasCompleteColumnValue(value) && !validateColumnValue(value, column);
  });
}

function primaryKeysFromStoredRow(
  data: Record<string, unknown>,
  columns: PopulateColumn[],
): Record<string, string> {
  return Object.fromEntries(
    columns
      .filter((column) => column.isPrimaryKey)
      .map((column) => [column.name, String(data[column.name] ?? "").trim()])
      .filter(([, value]) => value.length > 0),
  );
}

function samePrimaryKeys(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const [rightKey, rightValue] = rightEntries[index]!;
    return key === rightKey && value === rightValue;
  });
}

async function probePage(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
): Promise<PageEvidence> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_BROWSER_ATTEMPTS; attempt++) {
    let browser: Browser | undefined;
    try {
      throwIfRunAborted(input.datasetId, input.abortSignal);
      const session = await createTinyFishBrowserSession(
        apiKey,
        url,
        input.datasetId,
        input.abortSignal,
      );
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
    } catch (err) {
      if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
        throw err;
      }
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransientBrowserFailure(msg) || attempt === TRANSIENT_BROWSER_ATTEMPTS) {
        throw err;
      }
      console.warn(
        `[extractor_builder] probe browser attempt ${attempt}/${TRANSIENT_BROWSER_ATTEMPTS} failed; retrying: ${reasonForLog(msg)}`,
      );
      await sleep(500 * attempt);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function createTinyFishBrowserSession(
  apiKey: string,
  url: string,
  datasetId: string,
  abortSignal?: AbortSignal,
): Promise<TinyFishBrowserSession> {
  const response = await withRunTimeoutSignal(
    datasetId,
    FETCH_TIMEOUT_MS,
    (signal) =>
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
    abortSignal,
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
  abortSignal?: AbortSignal,
): Promise<T> {
  throwIfRunAborted(datasetId, abortSignal);
  const runSignal = getSignal(datasetId);

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const reason = new DOMException(
        `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        "TimeoutError",
      );
      controller.abort(reason);
      reject(reason);
    }, timeoutMs);
  });
  const abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const addAbortListener = (signal: AbortSignal | undefined) => {
      if (!signal) return;
      const listener = () => {
        const reason = abortSignalReason(signal);
        controller.abort(reason);
        reject(reason);
      };
      signal.addEventListener("abort", listener, { once: true });
      abortListeners.push({ signal, listener });
      if (signal.aborted) listener();
    };
    addAbortListener(runSignal);
    addAbortListener(abortSignal);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise, abortPromise]);
  } finally {
    clearTimeout(timeout!);
    for (const { signal, listener } of abortListeners) {
      signal.removeEventListener("abort", listener);
    }
  }
}

async function withRunAbortSignal<T>(
  datasetId: string,
  operation: (signal: AbortSignal) => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  throwIfRunAborted(datasetId, abortSignal);
  const runSignal = getSignal(datasetId);

  const controller = new AbortController();
  const abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const addAbortListener = (signal: AbortSignal | undefined) => {
      if (!signal) return;
      const listener = () => {
        const reason = abortSignalReason(signal);
        controller.abort(reason);
        reject(reason);
      };
      signal.addEventListener("abort", listener, { once: true });
      abortListeners.push({ signal, listener });
      if (signal.aborted) listener();
    };
    addAbortListener(runSignal);
    addAbortListener(abortSignal);
  });

  try {
    return await Promise.race([operation(controller.signal), abortPromise]);
  } finally {
    for (const { signal, listener } of abortListeners) {
      signal.removeEventListener("abort", listener);
    }
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

async function buildExtractorScriptWithAgent(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  modelSlug: string,
  repairContext?: {
    previousScript: string;
    failure: string;
  },
  options: {
    maxSteps?: number;
    phase?: string;
  } = {},
): Promise<AgenticExtractorBuildResult> {
  const llmConfig = await requireLlmProviderConfig();
  let testedScript: string | undefined;
  let finishedScript: string | undefined;
  let declinedReason: string | undefined;
  let lastEvidence: PageEvidence | undefined;
  let lastProbeSummary = `url=${url}`;
  const siteKey = siteKeyForInput(input, url);
  const phase = options.phase ?? (repairContext ? "repair" : "build");
  const maxSteps = options.maxSteps ?? EXTRACTOR_BUILDER_MAX_STEPS;

  console.log(
    `[extractor_builder] ${phase} started for ${siteKey} maxSteps=${maxSteps}`,
  );

  const inspectBrowserPageTool = createTool({
    id: "inspect_browser_page",
    description:
      "Open a URL with TinyFish Browser and return page evidence: final URL, title, meta description, structured candidate fields, and visible text excerpt. Use this whenever page structure is unclear.",
    inputSchema: z.object({
      url: z
        .string()
        .optional()
        .describe("Optional URL to inspect. If omitted, inspects the browser start URL."),
    }),
    outputSchema: z.object({
      finalUrl: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      candidateFields: z.array(
        z.object({
          key: z.string(),
          values: z.array(z.string()),
        }),
      ),
      visibleTextExcerpt: z.string(),
      error: z.string().optional(),
    }),
    execute: async ({ url: requestedUrl }) => {
      try {
        const targetUrl = coerceHttpUrl(requestedUrl) ?? url;
        console.log(`[extractor_builder] ${phase} inspecting ${targetUrl}`);
        const evidence = await probePage(apiKey, input, targetUrl);
        lastEvidence = evidence;
        lastProbeSummary = summarizeEvidenceForStorage(evidence);
        return evidenceForTool(evidence);
      } catch (err) {
        return {
          candidateFields: [],
          visibleTextExcerpt: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const testExtractorTool = createTool({
    id: "test_extractor",
    description:
      "Run a candidate sandboxed Bash/Python extractor against the representative row and return validation feedback. Call this repeatedly while improving the script.",
    inputSchema: z.object({
      script: z.string().describe("The full Bash extractor script. It may call BigSet page-* commands, curl, jq, and python3, and must print one JSON object."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      reason: z.string(),
      extractedColumns: z.array(z.string()).optional(),
      missingColumns: z.array(z.string()).optional(),
      requiredMissingColumns: z.array(z.string()).optional(),
      optionalMissingColumns: z.array(z.string()).optional(),
      rowSummary: z.string().optional(),
      sources: z.array(z.string()).optional(),
      dataPreview: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
    execute: async ({ script }) => {
      console.log(`[extractor_builder] ${phase} testing candidate for ${siteKey}`);
      const result = await testExtractorScriptDetailed(apiKey, input, url, script);
      if (result.ok) {
        testedScript = sanitizeGeneratedScript(script);
      }
      console.log(
        `[extractor_builder] ${phase} test ${result.ok ? "passed" : "failed"} for ${siteKey}: ${reasonForLog(result.reason)}`,
      );
      return detailedTestResultForTool(result);
    },
  });

  const finishExtractorTool = createTool({
    id: "finish_extractor",
    description:
      "Finalize a candidate extractor. This runs the same sandbox validation as test_extractor and only accepts the script if it passes.",
    inputSchema: z.object({
      script: z.string().describe("The full Bash extractor script to persist."),
      notes: z.string().optional().describe("Brief notes about the page pattern this script supports."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      reason: z.string(),
      extractedColumns: z.array(z.string()).optional(),
      missingColumns: z.array(z.string()).optional(),
      requiredMissingColumns: z.array(z.string()).optional(),
      optionalMissingColumns: z.array(z.string()).optional(),
    }),
    execute: async ({ script }) => {
      console.log(`[extractor_builder] ${phase} finishing candidate for ${siteKey}`);
      const result = await testExtractorScriptDetailed(apiKey, input, url, script);
      if (result.ok) {
        finishedScript = sanitizeGeneratedScript(script);
      }
      console.log(
        `[extractor_builder] ${phase} finish ${result.ok ? "accepted" : "rejected"} for ${siteKey}: ${reasonForLog(result.reason)}`,
      );
    return {
      ok: result.ok,
      reason: result.reason,
      extractedColumns: result.extraction?.extractedColumns,
      missingColumns: result.extraction?.missingColumns,
      requiredMissingColumns: result.extraction?.requiredMissingColumns,
      optionalMissingColumns: result.extraction?.optionalMissingColumns,
    };
  },
});

  const declineExtractorTool = createTool({
    id: "decline_extractor",
    description:
      "Use this when the representative row is not a good fit for a reusable sandboxed browser extractor, for example arbitrary unrelated URLs, CAPTCHA/blocking, or no stable page family.",
    inputSchema: z.object({
      reason: z.string().describe("Concrete reason this row/site pattern should fall back to the normal investigate agent."),
      category: z
        .enum([
          "mixed_unrelated_urls",
          "blocked_or_captcha",
          "no_stable_page_pattern",
          "insufficient_row_context",
          "other",
        ])
        .describe("Why codification is not appropriate."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      reason: z.string(),
      category: z.string(),
    }),
    execute: async ({ reason, category }) => {
      declinedReason = `${category}: ${reason}`;
      return { ok: true, reason, category };
    },
  });

  const agent = new Agent({
    id: "extractor-builder-agent",
    name: "Extractor Builder Agent",
    instructions: extractorBuilderAgentInstructions(),
    model: createLanguageModel(llmConfig, modelSlug),
    tools: {
      inspect_browser_page: inspectBrowserPageTool,
      test_extractor: testExtractorTool,
      finish_extractor: finishExtractorTool,
      decline_extractor: declineExtractorTool,
    },
  });

  const prompt = extractorBuilderAgentPrompt(input, url, repairContext);
  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await withRunAbortSignal(input.datasetId, (abortSignal) =>
      agent.generate(prompt, {
        abortSignal,
        maxSteps,
        modelSettings: {
          maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS.EXTRACTOR_BUILDER,
        },
      }),
      input.abortSignal,
    );
  } catch (err) {
    if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
      throw err;
    }
    if (finishedScript) {
      console.warn(
        `[extractor_builder] ${phase} returning finished script for ${siteKey} after agent error: ${reasonForLog(err instanceof Error ? err.message : String(err))}`,
      );
      return {
        script: finishedScript,
        probeSummary: lastEvidence ? summarizeEvidenceForStorage(lastEvidence) : lastProbeSummary,
      };
    }
    if (testedScript) {
      console.warn(
        `[extractor_builder] ${phase} had a tested script for ${siteKey}, but finish_extractor did not accept it before agent error: ${reasonForLog(err instanceof Error ? err.message : String(err))}`,
      );
    }
    throw err;
  }

  throwIfRunAborted(input.datasetId, input.abortSignal);
  console.log(
    `[extractor_builder] ${phase} ended for ${siteKey} steps=${result.steps?.length ?? "?"}`,
  );

  if (finishedScript) {
    console.log(
      `[extractor_builder] accepted finished script after ${result.steps?.length ?? "?"} steps for ${siteKey}`,
    );
    return {
      script: finishedScript,
      probeSummary: lastEvidence ? summarizeEvidenceForStorage(lastEvidence) : lastProbeSummary,
    };
  }

  if (testedScript) {
    console.warn(
      `[extractor_builder] ${phase} produced a tested script for ${siteKey}, but did not call finish_extractor`,
    );
  }

  if (declinedReason) {
    throw new Error(`extractor builder declined codification: ${declinedReason}`);
  }

  throw new Error(
    `extractor builder did not finish a validated script within ${maxSteps} steps`,
  );
}

async function repairExtractorAfterRuntimeFailure(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
  failure: string,
): Promise<RuntimeRepairResult> {
  const repairKey = extractorBuildKeyForInput(input, url);
  const siteKey = siteKeyForInput(input, url);
  const inFlightRepair = inFlightExtractorRepairs.get(repairKey);
  if (inFlightRepair) {
    console.log(`[row_extractor] waiting for in-flight extractor repair for ${siteKey}`);
    return await inFlightRepair;
  }

  const repairPromise = repairExtractorAfterRuntimeFailureImpl(
    apiKey,
    input,
    url,
    script,
    failure,
  ).finally(() => {
    inFlightExtractorRepairs.delete(repairKey);
  });
  inFlightExtractorRepairs.set(repairKey, repairPromise);
  return await repairPromise;
}

async function repairExtractorAfterRuntimeFailureImpl(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
  failure: string,
): Promise<RuntimeRepairResult> {
  const modelSlug = input.extractorBuilderModel ?? DEFAULT_MODEL_IDS.EXTRACTOR_BUILDER;
  const repaired = await buildExtractorScriptWithAgent(
    apiKey,
    input,
    url,
    modelSlug,
    {
      previousScript: script,
      failure,
    },
    {
      maxSteps: EXTRACTOR_REPAIR_MAX_STEPS,
      phase: "repair",
    },
  );
  const validation = await validateExtractorScript(apiKey, input, url, repaired.script);
  if (!validation.ok) {
    if (isNonRepairableValidationFailure(validation.reason)) {
      throw new NonRepairableExtractorFailure(validation.reason);
    }
    throw new Error(`repaired extractor failed validation: ${validation.reason}`);
  }

  const siteKey = siteKeyForInput(input, url);
  const columnsHash = hashColumns(input.columns);
  const smokeTest = await getExtractorSmokeTest(input, url);
  if (smokeTest) {
    const regression = await testExtractorScriptDetailed(
      apiKey,
      smokeTest.input,
      smokeTest.url,
      repaired.script,
    );
    if (!regression.ok) {
      if (isNonRepairableValidationFailure(regression.reason)) {
        throw new NonRepairableExtractorFailure(regression.reason);
      }
      throw new Error(
        `repaired extractor regressed ${smokeTest.source} known-good row: ${regression.reason}`,
      );
    }
    console.log(
      `[row_extractor] repaired extractor passed ${smokeTest.source} regression test for ${siteKey}`,
    );
  } else {
    console.warn(
      `[row_extractor] repaired extractor has no known-good regression row for ${siteKey}; using for this row without updating cache`,
    );
    return { script: repaired.script };
  }

  const stored = (await convex.mutation(internal.datasetExtractors.upsert, {
    datasetId: input.datasetId,
    siteKey,
    columnsHash,
    script: repaired.script,
    model: modelSlug,
    probeSummary: repaired.probeSummary,
  })) as { updatedAt: number };
  return {
    script: repaired.script,
    cachedExtractor: { script: repaired.script, updatedAt: stored.updatedAt },
  };
}

function isRowLevelQualityIssue(reason: string): boolean {
  return (
    reason.startsWith("generated extractor missed required columns:") ||
    reason.startsWith("generated extractor coverage too low:")
  );
}

function isNonRepairableRuntimeFailure(reason: string): boolean {
  return (
    isRowLevelQualityIssue(reason) ||
    /^primary key ".+" failed validation:/.test(reason) ||
    isHttpSourceFailure(reason) ||
    isTransientBrowserFailure(reason) ||
    /TinyFish Browser returned HTTP|Run was stopped|AbortError|TimeoutError/i.test(reason)
  );
}

function evidenceForTool(evidence: PageEvidence): {
  finalUrl: string;
  title?: string;
  description?: string;
  candidateFields: Array<{ key: string; values: string[] }>;
  visibleTextExcerpt: string;
} {
  return {
    finalUrl: evidence.finalUrl,
    title: evidence.title,
    description: evidence.description,
    candidateFields: Object.entries(evidence.candidates)
      .slice(0, 100)
      .map(([key, values]) => ({
        key,
        values: values.slice(0, 6),
      })),
    visibleTextExcerpt: evidence.bodyText.slice(0, 16_000),
  };
}

async function testExtractorScriptDetailed(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
): Promise<DetailedExtractorTestResult> {
  try {
    const sanitized = sanitizeGeneratedScript(script);
    const raw = await runGeneratedExtractorScriptForValidation(apiKey, input, url, sanitized);
    const extraction = buildRowFromExtractorResult(input, url, raw);
    if (!hasExtractedNonPrimaryValue(extraction, input.columns)) {
      return {
        ok: false,
        reason: "extractor returned no non-primary values",
        extraction,
      };
    }
    const qualityIssue = extractorQualityIssue(extraction, input.columns);
    if (qualityIssue) {
      return {
        ok: false,
        reason: qualityIssue,
        extraction,
      };
    }
    const hardcodedValues = hardcodedExtractorValues(sanitized, extraction, input, url);
    if (hardcodedValues.length > 0) {
      return {
        ok: false,
        reason: `extractor appears to hardcode representative-row values: ${hardcodedValues.join(", ")}`,
        extraction,
      };
    }
    return { ok: true, reason: "passed", extraction };
  } catch (err) {
    if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
      throw err;
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function detailedTestResultForTool(result: DetailedExtractorTestResult): {
  ok: boolean;
  reason: string;
  extractedColumns?: string[];
  missingColumns?: string[];
  requiredMissingColumns?: string[];
  optionalMissingColumns?: string[];
  rowSummary?: string;
  sources?: string[];
  dataPreview?: Record<string, ExtractedValue>;
} {
  return {
    ok: result.ok,
    reason: result.reason,
    extractedColumns: result.extraction?.extractedColumns,
    missingColumns: result.extraction?.missingColumns,
    requiredMissingColumns: result.extraction?.requiredMissingColumns,
    optionalMissingColumns: result.extraction?.optionalMissingColumns,
    rowSummary: result.extraction?.rowSummary,
    sources: result.extraction?.sources,
    dataPreview: result.extraction?.data,
  };
}

function reasonForLog(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function extractorBuilderAgentInstructions(): string {
  return `You are BigSet's autonomous extractor builder agent.

Your job is to build a reusable sandboxed extractor script for one dataset/page family. You have browser inspection and sandbox testing tools. Use whichever tools fit the situation; do not follow a rigid checklist.

Critical behavior:
- Inspect pages when structure, source URLs, or primary key semantics are unclear.
- Do not decline because a source has an anti-bot reputation. BigSet uses TinyFish Browser for interactive browser access; inspect the representative page and judge the actual session result.
- Write and test candidate scripts with test_extractor. Iterate on validation errors.
- Finish only by calling finish_extractor with the final script. A final text response without finish_extractor is failure.
- If the dataset is not a good fit for reusable browser codification, call decline_extractor with a concrete reason.
- Treat this as a general page-family compiler. Do not optimize for any named site. The page family may be a marketplace listing, social group, product page, blog post archive, repository page, directory profile, forum thread, app-store listing, or any other accessible browser surface.

When to decline:
- The representative primary keys/URLs point at arbitrary unrelated domains with no shared page pattern.
- The representative page remains blocked by login, paywall, CAPTCHA, bot detection, or inaccessible content after a TinyFish Browser inspection attempt.
- The row context is too ambiguous to construct or find a stable browser target.
- TinyFish Browser can access the page but the requested values require actions/data outside the accessible page family and cannot be reliably derived.

Important modeling rules:
- Primary keys are arbitrary row identifiers. They do not have to be URLs.
- You may construct navigation URLs from input.primaryKeys, top-level primary key fields, input.urls, input.sourceHint, dataset name, description, retrieval strategy, and context.
- If the source/schema imply a URL template, build the row URL from the primary key or identifier. This applies to any source family: handles, slugs, product IDs, post paths, item IDs, listing IDs, package names, tickers, and similar identifiers.
- Search is a last resort when a deterministic source URL can be built.
- Multiple known page families are allowed. If rows consistently contain URLs from a small set of stable domains or path patterns, write one reusable script that branches based on the available URL/domain. If rows are arbitrary unrelated URLs, decline.
- Respect validation_regex exactly. Normalize values before returning them, using normalization_hint and column descriptions.
- Attempt every column, including nullable/optional columns. Nullable means the final row may survive if all methods fail, not that you should skip the field.
- You may derive values from page structure instead of finding literal labels. For example: count repeated cards in a relevant section, infer booleans from the presence of controls/badges, parse counts from aria labels, or normalize visible variants into the schema's final format.

Script contract:
- Return only a full Bash script in tool arguments, never Markdown fences.
- Do not write JavaScript. Do not define async function extract. Do not use Playwright APIs directly.
- The script runs in a just-bash sandbox with a virtual filesystem. It can read /input.json, /schema.json, and /helpers.py.
- The script must print exactly one JSON object on stdout as its final non-empty line.
- The script may use Bash, jq, sed, awk, grep, rg, yq, xan, sqlite3, tar/gzip, curl, and python3.
- Python may import /helpers.py for clean_text, parse_compact_number, parse_number, parse_price, parse_rating, and absolute_url.
- JavaScript execution is unavailable. Network access is public HTTP(S) GET/HEAD only via curl; private/internal hosts are blocked.
- Browser access is only through these BigSet commands:
  - page-goto [url]: navigate the TinyFish Browser page and print the final URL.
  - page-url: print the current page URL.
  - page-title: print the page title.
  - page-text CSS_SELECTOR: print the first matching element's cleaned text.
  - page-texts CSS_SELECTOR [limit]: print a JSON array of cleaned matching texts.
  - page-attr CSS_SELECTOR ATTRIBUTE: print the first matching element attribute.
  - page-count CSS_SELECTOR: print the match count.
  - page-exists CSS_SELECTOR: print true or false.
  - page-wait CSS_SELECTOR [timeout_ms]: wait for a visible element.
  - page-click CSS_SELECTOR: click an element and print the resulting URL.
  - page-fill CSS_SELECTOR VALUE: fill an input.
  - page-meta NAME_OR_PROPERTY: print a meta tag content value, or canonical for canonical link.
  - page-jsonld: print a JSON array of parsed application/ld+json objects.
  - page-links [limit]: print a JSON array of {text, href} links.
  - page-visible-text [limit]: print cleaned visible page text.
- Prefer stable DOM sources: JSON-LD, meta tags, tables, definition lists, visible labels, aria labels, canonical links, and semantically named selectors.
- Return { data, column_status, cell_sources, sources, row_summary, how_found }.
- data should include every dataset column that the sandboxed browser commands can extract or derive. Preserve primary key values from input.primaryKeys.
- column_status should include every dataset column. Use status "extracted" or "derived" for values in data. Use "not_present_on_page", "blocked", "ambiguous", "validation_failed", or "fallback_needed" for unresolved values, with a short reason.
- cell_sources should map each extracted/derived column to the exact HTTP URL(s) that justify that specific value. Do not put row-level sources here.
- Returned sources must be HTTP URLs you actually used.
- If any column cannot be extracted or normalized to satisfy validation_regex, keep investigating with the browser tools. If it still cannot be solved from the browser page family, mark it in column_status for fallback instead of fabricating a value.

Starter-code reference only. This shape will not work on the target site until you inspect the actual page and replace the URL construction/selectors:
#!/usr/bin/env bash
set -e

page-goto "$START_URL" >/tmp/page_url.txt
title="$(page-text 'h1')"
current_url="$(page-url)"

TITLE="$title" CURRENT_URL="$current_url" python3 - <<'PY'
import json, os
from helpers import clean_text

input_data = json.load(open("/input.json"))
title = clean_text(os.environ.get("TITLE", ""))
url = os.environ.get("CURRENT_URL", "")
item_id = input_data.get("primaryKeys", {}).get("item_id") or input_data.get("item_id", "")
result = {
    "data": {"item_id": item_id, "title": title},
    "column_status": {
        "item_id": {"status": "extracted"},
        "title": {"status": "extracted"} if title else {"status": "fallback_needed", "reason": "No h1/title equivalent found after inspection"},
    },
    "cell_sources": {"title": [url]} if title else {},
    "sources": [url],
    "row_summary": title or item_id or url,
    "how_found": "Opened the row target with TinyFish Browser and extracted values using sandboxed BigSet page commands.",
}
print(json.dumps(result, separators=(",", ":")))
PY

Never hardcode representative-row values in the script. Literal values from the first tested row, such as a specific product name, profile URL, rating, count, or homepage, make the extractor invalid unless they come from input primary keys or are source-family constants like a host prefix.`;
}

function extractorBuilderAgentPrompt(
  input: TryRowExtractorInput,
  url: string,
  repairContext?: {
    previousScript: string;
    failure: string;
  },
): string {
  const columns = input.columns
    .map((column) => columnPromptLine(column))
    .join("\n");
  const primaryKeys = Object.entries(input.primaryKeys)
    .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
    .join("\n") || "(none)";
  const urls = (input.urls ?? []).map((value) => `- ${value}`).join("\n") || "(none)";
  const repair = repairContext
    ? `
You are repairing a previous extractor. The previous script failed with:
${repairContext.failure}

Previous script:
${repairContext.previousScript.slice(0, 20_000)}
`
    : "";

  return `Build a reusable sandboxed Bash/Python extractor for this BigSet dataset.

Dataset:
- Name: ${input.datasetName ?? ""}
- Description: ${input.description ?? ""}
- Retrieval strategy: ${input.retrievalStrategy ?? ""}
- Source hint: ${input.sourceHint ?? ""}
- Context: ${input.context ?? ""}

Dataset columns:
${columns}

Primary key values for the representative row:
${primaryKeys}

Candidate URLs from row context:
${urls}

Representative browser start URL:
${url}

Use the tools to inspect, test, revise, finish, or decline. The goal is a validated script, not a prose answer.${repair}`;
}

function columnPromptLine(column: PopulateColumn): string {
  const details = [
    column.isPrimaryKey ? "PRIMARY KEY" : undefined,
    column.nullable === undefined ? undefined : `nullable=${column.nullable}`,
    column.validationRegex
      ? `validation_regex=${JSON.stringify(column.validationRegex)}`
      : undefined,
    column.normalizationHint
      ? `normalization_hint=${JSON.stringify(column.normalizationHint)}`
      : undefined,
    column.description ? `retrieval_hint=${JSON.stringify(column.description)}` : undefined,
  ].filter(Boolean);
  return `- ${JSON.stringify(column.name)} (${column.type})${
    details.length > 0 ? ` [${details.join("; ")}]` : ""
  }`;
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
  const fenced = text.match(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text)
    .trim();
  rejectUnsupportedGeneratedScript(raw);
  if (!raw) {
    throw new Error("generated extractor script was empty");
  }
  return raw;
}

function rejectUnsupportedGeneratedScript(script: string): void {
  const legacyJavaScriptPatterns = [
    /^\s*(?:export\s+)?async\s+function\s+extract\s*\(/m,
    /^\s*(?:export\s+)?function\s+extract\s*\(/m,
    /\bpage\.locator\s*\(/,
    /\bnew\s+vm\.Script\b/,
  ];
  const match = legacyJavaScriptPatterns.find((pattern) => pattern.test(script));
  if (match) {
    throw new Error(
      "legacy JavaScript extractor scripts are disabled; generate a Bash/Python extractor instead",
    );
  }
}

async function validateExtractorScript(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await testExtractorScriptDetailed(apiKey, input, url, script);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

async function runGeneratedExtractorScriptForValidation(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
): Promise<GeneratedExtractorResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_BROWSER_ATTEMPTS; attempt++) {
    try {
      throwIfRunAborted(input.datasetId, input.abortSignal);
      return await runGeneratedExtractorScript(apiKey, input, url, script);
    } catch (err) {
      if (isAbortLikeError(err) && runWasAborted(input.datasetId, input.abortSignal)) {
        throw err;
      }
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransientBrowserFailure(msg) || attempt === TRANSIENT_BROWSER_ATTEMPTS) {
        throw err;
      }
      console.warn(
        `[extractor_builder] validation browser attempt ${attempt}/${TRANSIENT_BROWSER_ATTEMPTS} failed; retrying: ${reasonForLog(msg)}`,
      );
      await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runGeneratedExtractorScript(
  apiKey: string,
  input: TryRowExtractorInput,
  url: string,
  script: string,
): Promise<GeneratedExtractorResult> {
  throwIfRunAborted(input.datasetId, input.abortSignal);
  const sanitized = sanitizeGeneratedScript(script);
  const session = await createTinyFishBrowserSession(
    apiKey,
    url,
    input.datasetId,
    input.abortSignal,
  );
  const payload = JSON.stringify({
    cdpUrl: session.cdp_url,
    url,
    script: sanitized,
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
    const runSignal = getSignal(input.datasetId);
    try {
      throwIfRunAborted(input.datasetId, input.abortSignal);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(process.execPath, ["--input-type=module", "-e", EXTRACTOR_RUNNER_SOURCE], {
      cwd: BACKEND_ROOT,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      for (const { signal, listener } of abortListeners) {
        signal.removeEventListener("abort", listener);
      }
    };
    const addAbortListener = (signal: AbortSignal | undefined) => {
      if (!signal) return;
      const listener = () => {
        child.kill("SIGKILL");
        cleanup();
        reject(abortSignalReason(signal));
      };
      signal.addEventListener("abort", listener, { once: true });
      abortListeners.push({ signal, listener });
      if (signal.aborted) listener();
    };
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("generated extractor timed out"));
    }, EXTRACTOR_RUNNER_TIMEOUT_MS + 5_000);
    addAbortListener(runSignal);
    addAbortListener(input.abortSignal);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > EXTRACTOR_SCRIPT_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        cleanup();
        reject(new Error("generated extractor output limit exceeded"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
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
  const requiredMissingColumns: string[] = [];
  const optionalMissingColumns: string[] = [];
  const rawColumnStatuses = normalizeColumnStatuses(
    result.column_status ?? result.columnStatus,
  );
  const columnStatuses: Record<string, ColumnStatus> = {};

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
      columnStatuses[column.name] = {
        status: rawColumnStatuses[column.name]?.status ?? "extracted",
        reason: rawColumnStatuses[column.name]?.reason,
      };
      continue;
    }

    const rawValue = result.data[column.name];
    const value = coerceColumnValue(rawValueToExtractedValue(rawValue), column, url);
    if (value !== undefined && hasCompleteColumnValue(value)) {
      const validationError = validateColumnValue(value, column);
      if (!validationError) {
        data[column.name] = value;
        extractedColumns.push(column.name);
        columnStatuses[column.name] = {
          status: rawColumnStatuses[column.name]?.status ?? "extracted",
          reason: rawColumnStatuses[column.name]?.reason,
        };
        continue;
      }
      columnStatuses[column.name] = {
        status: "validation_failed",
        reason: validationError,
      };
    }

    if (existingData && existingData[column.name] !== undefined) {
      const storedValue = normalizeStoredValue(existingData[column.name]);
      if (hasCompleteColumnValue(storedValue)) {
        const validationError = validateColumnValue(storedValue, column);
        if (!validationError) {
          data[column.name] = storedValue;
          columnStatuses[column.name] = {
            status: rawColumnStatuses[column.name]?.status ?? "extracted",
            reason: rawColumnStatuses[column.name]?.reason ?? "Preserved existing validated value.",
          };
          continue;
        }
      }
    }

    data[column.name] = "";
    missingColumns.push(column.name);
    if (isRequiredColumn(column)) {
      requiredMissingColumns.push(column.name);
    } else {
      optionalMissingColumns.push(column.name);
    }
    columnStatuses[column.name] = columnStatuses[column.name] ?? rawColumnStatuses[column.name] ?? {
      status: "fallback_needed",
      reason: "The browser extractor did not return a validated value.",
    };
  }

  const sources = Array.isArray(result.sources)
    ? result.sources.filter((source): source is string => typeof source === "string" && isHttpUrl(source))
    : [];
  const cellSources = normalizeCellSources(result.cell_sources ?? result.cellSources);
  const summary = String(result.row_summary ?? result.rowSummary ?? "").trim().slice(0, 500);

  return {
    data,
    sources: sources.length > 0 ? sources : [url],
    rowSummary: summary || url,
    cellSources,
    extractedColumns,
    missingColumns,
    requiredMissingColumns,
    optionalMissingColumns,
    columnStatuses,
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

function extractorQualityIssue(
  extraction: GenericExtraction,
  columns: PopulateColumn[],
): string | undefined {
  const nonPrimaryColumns = columns.filter((column) => !column.isPrimaryKey);
  if (nonPrimaryColumns.length === 0) return undefined;

  const extracted = new Set(extraction.extractedColumns);
  const missing = new Set(extraction.missingColumns);
  const extractedNonPrimary = nonPrimaryColumns.filter((column) => extracted.has(column.name));
  const missingCellSources = extractedNonPrimary.filter(
    (column) => (extraction.cellSources[column.name]?.length ?? 0) === 0,
  );
  if (missingCellSources.length > 0) {
    return `generated extractor omitted cell_sources for extracted columns: ${missingCellSources.map((column) => column.name).join(", ")}`;
  }

  const missingRequired = nonPrimaryColumns.filter(
    (column) => isRequiredColumn(column) && missing.has(column.name),
  );
  if (missingRequired.length > 0) {
    return `generated extractor missed required columns: ${missingRequired.map((column) => column.name).join(", ")}`;
  }

  const minimum = minimumBrowserExtractedColumnCount(nonPrimaryColumns.length);
  if (extractedNonPrimary.length < minimum) {
    const missingColumns = nonPrimaryColumns
      .filter((column) => !extracted.has(column.name))
      .map((column) => column.name);
    return [
      `generated extractor coverage too low: extracted ${extractedNonPrimary.length}/${nonPrimaryColumns.length} non-primary columns`,
      `minimum=${minimum}`,
      `missing=${missingColumns.join(", ") || "(none)"}`,
    ].join("; ");
  }

  return undefined;
}

function minimumBrowserExtractedColumnCount(nonPrimaryColumnCount: number): number {
  if (nonPrimaryColumnCount <= 1) return nonPrimaryColumnCount;
  return Math.floor(nonPrimaryColumnCount / 2) + 1;
}

function hardcodedExtractorValues(
  script: string,
  extraction: GenericExtraction,
  input: TryRowExtractorInput,
  url: string,
): string[] {
  const scriptText = script.toLowerCase();
  const pkColumns = new Set(
    input.columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
  );
  const sourceUrls = new Set(
    [url, ...(input.urls ?? []), input.sourceHint]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
  const violations: string[] = [];

  for (const [columnName, value] of Object.entries(extraction.data)) {
    if (pkColumns.has(columnName)) continue;
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length < 8) continue;
    const lowerValue = normalized.toLowerCase();
    if (sourceUrls.has(lowerValue)) continue;
    if (!scriptText.includes(lowerValue)) continue;
    violations.push(`${columnName}=${JSON.stringify(normalized.slice(0, 120))}`);
  }

  return violations.slice(0, 8);
}

function isRequiredColumn(column: PopulateColumn): boolean {
  return column.isPrimaryKey === true || column.nullable === false;
}

function normalizeColumnStatuses(value: unknown): Record<string, ColumnStatus> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const statuses: Record<string, ColumnStatus> = {};
  for (const [column, rawStatus] of Object.entries(value as Record<string, unknown>)) {
    const normalized =
      typeof rawStatus === "string"
        ? { status: normalizeColumnStatus(rawStatus) }
        : rawStatus && typeof rawStatus === "object"
          ? {
              status: normalizeColumnStatus(
                String((rawStatus as { status?: unknown }).status ?? "fallback_needed"),
              ),
              reason:
                typeof (rawStatus as { reason?: unknown }).reason === "string"
                  ? String((rawStatus as { reason?: unknown }).reason).slice(0, 300)
                  : undefined,
            }
          : { status: "fallback_needed" as const };
    statuses[column] = normalized;
  }
  return statuses;
}

function normalizeColumnStatus(value: string): ColumnExtractionStatus {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  switch (normalized) {
    case "extracted":
    case "derived":
    case "not_present_on_page":
    case "blocked":
    case "ambiguous":
    case "validation_failed":
    case "fallback_needed":
    case "missing":
      return normalized;
    case "not_found":
    case "unavailable":
    case "not_visible":
      return "not_present_on_page";
    default:
      return "fallback_needed";
  }
}

function normalizeCellSources(value: unknown): Record<string, string[]> {
  if (!value) return {};

  const output: Record<string, string[]> = {};
  const add = (column: string, sources: unknown) => {
    const normalizedColumn = column.trim().replace(/^["`]+|["`]+$/g, "");
    if (!normalizedColumn) return;
    const sourceValues = Array.isArray(sources) ? sources : [sources];
    const cleaned = [
      ...new Set(
        sourceValues.filter((source): source is string => {
          return typeof source === "string" && isHttpUrl(source);
        }),
      ),
    ];
    if (cleaned.length > 0) output[normalizedColumn] = cleaned;
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const column = (entry as { column?: unknown }).column;
      if (typeof column !== "string") continue;
      add(column, (entry as { sources?: unknown; source?: unknown }).sources ?? (entry as { source?: unknown }).source);
    }
    return output;
  }

  if (typeof value === "object") {
    for (const [column, sources] of Object.entries(value as Record<string, unknown>)) {
      add(column, sources);
    }
  }

  return output;
}

function rawValueToExtractedValue(value: unknown): ExtractedValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (value == null) return undefined;
  return String(value);
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

function siteKeyForUrl(
  value: string,
  primaryKeys: Record<string, string> = {},
): string {
  try {
    const url = new URL(value);
    const primaryKeySegments = siteKeyPrimaryValueSegments(primaryKeys);
    const pathShape = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 3)
      .map((segment, index) =>
        normalizeSiteKeyPathSegment(segment, index, primaryKeySegments),
      )
      .filter((segment): segment is string => Boolean(segment));
    return [url.hostname.toLowerCase(), ...pathShape].filter(Boolean).join("/");
  } catch {
    return "invalid-url";
  }
}

function siteKeyForInput(input: TryRowExtractorInput, browserStartUrl: string): string {
  const sourceUrl = browserStartUrlCandidates(input)
    .map(coerceHttpUrl)
    .find((value): value is string => Boolean(value));
  return siteKeyForUrl(sourceUrl ?? browserStartUrl, input.primaryKeys);
}

function siteKeyPrimaryValueSegments(primaryKeys: Record<string, string>): Set<string> {
  const values = new Set<string>();
  for (const value of Object.values(primaryKeys)) {
    const normalized = normalizeSiteKeyLiteral(value);
    const slug = slugifySiteKeyLiteral(value);
    if (normalized) values.add(normalized);
    if (slug) values.add(slug);
    for (const segment of siteKeyUrlPathSegments(value)) {
      values.add(segment);
    }
  }
  return values;
}

function siteKeyUrlPathSegments(value: string): string[] {
  try {
    const url = new URL(value);
    return url.pathname
      .split("/")
      .filter(Boolean)
      .map(normalizeSiteKeyLiteral)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeSiteKeyPathSegment(
  value: string,
  index: number,
  primaryKeySegments: Set<string>,
): string | undefined {
  const normalized = normalizeSiteKeyLiteral(value);
  if (!normalized) return undefined;
  if (
    index > 0 &&
    (primaryKeySegments.has(normalized) || looksDynamicSiteKeySegment(normalized))
  ) {
    return ":value";
  }
  return normalized;
}

function looksDynamicSiteKeySegment(value: string): boolean {
  return (
    /^\d+$/.test(value) ||
    /^[0-9a-f]{12,}$/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    (value.length >= 6 && /\d/.test(value))
  );
}

function normalizeSiteKeyLiteral(value: string): string {
  try {
    return decodeURIComponent(value).toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^-+|-+$/g, "");
  } catch {
    return value.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^-+|-+$/g, "");
  }
}

function slugifySiteKeyLiteral(value: string): string {
  return normalizeSiteKeyLiteral(value.replace(/&/g, " and "));
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
      return String(value).trim() || undefined;
  }
}

function hasCompleteColumnValue(value: ExtractedValue): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return true;
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
