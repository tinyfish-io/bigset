import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type {
  BrowserActionBoxHooks,
  BrowserActionBoxReplayInput,
  PlaywrightReplayRunnerResult,
  PlaywrightScriptArtifact,
} from "./populate-browser-action-box.js";
import type { PopulateRuntimeTraceStep } from "./populate-runtime.js";
import type { Browser, Page } from "playwright-core";

export interface LocalPlaywrightReplayRunnerOptions {
  executablePath?: string;
  headless?: boolean;
  launchArgs?: string[];
}

interface LinkCandidate {
  href: string;
  title: string;
  text: string;
  ariaLabel?: string;
}

interface ReplayPageSnapshot {
  url: string;
  title: string;
  evidenceQuote: string;
}

export function createLocalPlaywrightReplayRunner(
  options: LocalPlaywrightReplayRunnerOptions = {}
): NonNullable<BrowserActionBoxHooks["runPlaywrightScript"]> {
  return (input) => runLocalPlaywrightReplay(input, options);
}

export function createDeterministicPlaywrightRepair(): NonNullable<
  BrowserActionBoxHooks["repairPlaywrightScript"]
> {
  return async (input) => {
    const repairedCode = repairGeneratedScriptSourceUrls({
      code: input.currentPlaywrightScript.code,
      sourceUrl: input.sourceUrl,
    });
    if (repairedCode === input.currentPlaywrightScript.code) {
      return null;
    }
    return {
      ...input.currentPlaywrightScript,
      scriptId: `${input.currentPlaywrightScript.scriptId}-repair-${shortHash(repairedCode)}`,
      status: "draft",
      createdAt: new Date().toISOString(),
      code: repairedCode,
      diagnostics: [
        ...input.currentPlaywrightScript.diagnostics,
        "Repaired generated script URL anchors to match the recipe source URL.",
      ],
    };
  };
}

export async function runLocalPlaywrightReplay(
  input: BrowserActionBoxReplayInput & { script: PlaywrightScriptArtifact },
  options: LocalPlaywrightReplayRunnerOptions = {}
): Promise<PlaywrightReplayRunnerResult> {
  const startedAt = new Date().toISOString();
  const steps: PopulateRuntimeTraceStep[] = [];
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    const executablePath = options.executablePath ?? findChromiumExecutable();
    browser = await launchChromium({
      executablePath,
      headless: options.headless ?? true,
      launchArgs: options.launchArgs,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(Math.min(input.runCaps.timeoutMs, 30_000));
    page.setDefaultNavigationTimeout(Math.min(input.runCaps.timeoutMs, 30_000));
    steps.push({
      kind: "browser",
      label: "playwright-launch",
      status: "succeeded",
      input: {
        executablePath: executablePath ?? "playwright-default",
        headless: options.headless ?? true,
      },
    });

    const recipeResult = await withTimeout(
      runScriptModule({
        script: input.script,
        page,
        replayInput: input,
      }),
      input.runCaps.timeoutMs,
      "Playwright replay timed out."
    );
    steps.push({
      kind: "browser",
      label: "playwright-script-run",
      status: "succeeded",
      input: {
        sourceUrl: input.sourceUrl,
        scriptId: input.script.scriptId,
      },
      output: {
        returnedRows: agentCompatibleRows(recipeResult).length,
      },
    });

    const agentCompatibleResult =
      agentCompatibleRows(recipeResult).length > 0
        ? recipeResult
        : await extractAgentCompatibleRowsFromPage({
          page,
          replayInput: input,
          recipeResult,
          steps,
        });

    return {
      agentCompatibleResult,
      trace: {
        status: "succeeded",
        startedAt,
        completedAt: new Date().toISOString(),
        currentUrl: safePageUrl(page),
        diagnostics: [],
        steps,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({
      kind: "browser",
      label: "playwright-replay-failure",
      status: "failed",
      input: {
        sourceUrl: input.sourceUrl,
        scriptId: input.script.scriptId,
      },
      error: message,
    });
    return {
      agentCompatibleResult: null,
      error: message,
      trace: {
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        currentUrl: safePageUrl(page),
        diagnostics: await failureDiagnostics(page, message),
        steps,
      },
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function launchChromium(input: {
  executablePath?: string;
  headless: boolean;
  launchArgs?: string[];
}) {
  const { chromium } = await import("playwright-core");
  return chromium.launch({
    executablePath: input.executablePath,
    headless: input.headless,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      ...(input.launchArgs ?? []),
    ],
  });
}

async function runScriptModule(input: {
  script: PlaywrightScriptArtifact;
  page: Page;
  replayInput: BrowserActionBoxReplayInput;
}): Promise<Record<string, unknown>> {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    input.script.code
  ).toString("base64")}#${randomUUID()}`;
  const mod = await import(moduleUrl);
  if (typeof mod.runDatasetRecipe !== "function") {
    throw new Error("Playwright script must export runDatasetRecipe(context).");
  }
  const result = await mod.runDatasetRecipe({
    page: input.page,
    sourceUrl: input.replayInput.sourceUrl,
    datasetGoalPrompt: input.replayInput.datasetGoalPrompt,
    datasetSchema: input.replayInput.datasetSchema,
    inputs: {},
    timeoutMs: input.replayInput.runCaps.timeoutMs,
  });
  return isRecord(result) ? result : { rows: [] };
}

async function extractAgentCompatibleRowsFromPage(input: {
  page: Page;
  replayInput: BrowserActionBoxReplayInput;
  recipeResult: Record<string, unknown>;
  steps: PopulateRuntimeTraceStep[];
}): Promise<Record<string, unknown>> {
  const candidates = await input.page.evaluate(({ sourceUrl }) => {
    const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, "");
    return Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => {
        const href = new URL(anchor.getAttribute("href") ?? "", document.baseURI).href;
        const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
        const ariaLabel = anchor.getAttribute("aria-label") ?? undefined;
        const title = anchor.getAttribute("title") ?? ariaLabel ?? text;
        const host = new URL(href).hostname.replace(/^www\./, "");
        return {
          href,
          title: title.trim(),
          text,
          ariaLabel,
          sameHost: host === sourceHost,
        };
      })
      .filter((candidate) => /^https?:\/\//i.test(candidate.href))
      .filter((candidate) => !/(signin|login|signup|privacy|terms|cookie|contact|mailto:)/i.test(candidate.href))
      .filter((candidate) => candidate.sameHost || candidate.text.length > 12)
      .slice(0, 80);
  }, { sourceUrl: input.replayInput.sourceUrl });
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: replayCandidateScore(candidate, input.replayInput),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.href.localeCompare(right.href)
    );
  const unique = dedupeByHref(ranked).slice(0, targetReplayRowCount(input.replayInput));
  let rows = unique.map((candidate) =>
    rowFromCandidate({
      candidate,
      replayInput: input.replayInput,
    })
  );
  let sourceUrls = unique.map((candidate) => candidate.href);
  if (rows.length === 0) {
    const snapshot = await replayPageSnapshot(input.page);
    const pageRow = rowFromPageSnapshot({
      snapshot,
      replayInput: input.replayInput,
    });
    if (pageRow) {
      rows = [pageRow];
      sourceUrls = [snapshot.url];
    }
  }
  input.steps.push({
    kind: "extract",
    label: "playwright-dom-extract",
    status: rows.length > 0 ? "succeeded" : "failed",
    input: {
      sourceUrl: input.replayInput.sourceUrl,
      candidateCount: candidates.length,
    },
    output: {
      rowCount: rows.length,
    },
    error: rows.length > 0 ? undefined : "Replay DOM extraction found no rows.",
  });
  return {
    records: rows,
    sourceUrls,
    replayNotes: arrayValue(input.recipeResult.notes).filter(isString).slice(0, 20),
  };
}

function rowFromCandidate(input: {
  candidate: LinkCandidate;
  replayInput: BrowserActionBoxReplayInput;
}): Record<string, unknown> {
  const evidenceQuote = bestEvidenceQuote(input.candidate);
  const cells: Record<string, unknown> = {};
  for (const column of input.replayInput.datasetSchema.columns) {
    const columnName = column.name;
    if (/(url|link|website|source)/i.test(columnName)) {
      cells[columnName] = input.candidate.href;
    } else if (/(title|name|company|article|post)/i.test(columnName)) {
      cells[columnName] = input.candidate.title || input.candidate.text;
    } else if (/(evidence|quote|summary|description|snippet)/i.test(columnName)) {
      cells[columnName] = evidenceQuote;
    } else if (/(date|published|year)/i.test(columnName)) {
      cells[columnName] = dateFromText(input.candidate.text) ?? null;
    } else {
      cells[columnName] = input.candidate.title || input.candidate.text || null;
    }
  }
  return {
    ...cells,
    sourceUrls: [input.candidate.href],
    evidence: [{
      field: "evidence_quote",
      url: input.candidate.href,
      quote: evidenceQuote,
    }],
  };
}

async function replayPageSnapshot(page: Page): Promise<ReplayPageSnapshot> {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const title = (document.title || "")
      .replace(/\s+/g, " ")
      .trim();
    const evidenceQuote = bodyText.slice(0, 500);
    return {
      url: window.location.href,
      title: title || evidenceQuote.slice(0, 120) || window.location.href,
      evidenceQuote,
    };
  });
}

function rowFromPageSnapshot(input: {
  snapshot: ReplayPageSnapshot;
  replayInput: BrowserActionBoxReplayInput;
}): Record<string, unknown> | undefined {
  if (!input.snapshot.evidenceQuote) {
    return undefined;
  }
  const cells: Record<string, unknown> = {};
  for (const column of input.replayInput.datasetSchema.columns) {
    const columnName = column.name;
    if (/(url|link|website|source)/i.test(columnName)) {
      cells[columnName] = input.snapshot.url;
    } else if (/(title|name|company|article|post)/i.test(columnName)) {
      cells[columnName] = input.snapshot.title;
    } else if (/(evidence|quote|summary|description|snippet)/i.test(columnName)) {
      cells[columnName] = input.snapshot.evidenceQuote;
    } else if (/(date|published|year)/i.test(columnName)) {
      cells[columnName] = dateFromText(input.snapshot.evidenceQuote) ?? null;
    } else {
      cells[columnName] = input.snapshot.title || input.snapshot.evidenceQuote;
    }
  }
  return {
    ...cells,
    sourceUrls: [input.snapshot.url],
    evidence: [{
      field: "evidence_quote",
      url: input.snapshot.url,
      quote: input.snapshot.evidenceQuote,
    }],
  };
}

function replayCandidateScore(
  candidate: LinkCandidate & { sameHost?: boolean },
  input: BrowserActionBoxReplayInput
): number {
  const haystack = `${candidate.href} ${candidate.title} ${candidate.text}`.toLowerCase();
  let score = candidate.sameHost ? 4 : 1;
  if (candidate.title.length >= 8) score += 2;
  if (candidate.text.length >= 20) score += 1;
  if (/(privacy|terms|login|signin|signup|careers|contact|about|download)/i.test(haystack)) {
    score -= 8;
  }
  for (const term of replayIntentTerms(input)) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function replayIntentTerms(input: BrowserActionBoxReplayInput): string[] {
  return Array.from(new Set(
    [
      ...input.datasetGoalPrompt.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [],
      ...input.datasetSchema.columns.flatMap((column) =>
        column.name.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []
      ),
    ].filter((term) =>
      !/^(with|from|this|that|rows?|each|page|source|include|current|public)$/.test(term)
    )
  )).slice(0, 20);
}

function targetReplayRowCount(input: BrowserActionBoxReplayInput): number {
  const min = input.previousSuccessfulOutputProfile.rowCountRange?.min ?? 1;
  const max = input.previousSuccessfulOutputProfile.rowCountRange?.max ?? Math.max(10, min);
  return Math.max(1, Math.min(max, Math.max(min, 10)));
}

function dedupeByHref<T extends { href: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const candidate of candidates) {
    const href = canonicalUrl(candidate.href);
    if (seen.has(href)) continue;
    seen.add(href);
    rows.push(candidate);
  }
  return rows;
}

function repairGeneratedScriptSourceUrls(input: {
  code: string;
  sourceUrl: string;
}): string {
  let changed = false;
  const repaired = input.code.replace(
    /https?:\/\/[^"'`\]\s)]+/g,
    (url) => {
      if (canonicalUrl(url) === canonicalUrl(input.sourceUrl)) {
        return url;
      }
      try {
        const urlHost = new URL(url).hostname.replace(/^www\./, "");
        const sourceHost = new URL(input.sourceUrl).hostname.replace(/^www\./, "");
        if (urlHost !== sourceHost || /example\.invalid|broken|localhost/i.test(url)) {
          changed = true;
          return input.sourceUrl;
        }
      } catch {
        changed = true;
        return input.sourceUrl;
      }
      return url;
    }
  );
  return changed ? repaired : input.code;
}

function findChromiumExecutable(): string | undefined {
  for (const candidate of [
    process.env.POPULATE_PLAYWRIGHT_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function failureDiagnostics(
  page: Page | undefined,
  message: string
): Promise<string[]> {
  if (!page) {
    return [message];
  }
  const title = await page.title().catch(() => "");
  return [
    message,
    `Current URL: ${page.url()}`,
    ...(title ? [`Page title: ${title.slice(0, 160)}`] : []),
  ];
}

function safePageUrl(page: Page | undefined): string | undefined {
  try {
    return page?.url();
  } catch {
    return undefined;
  }
}

function bestEvidenceQuote(candidate: LinkCandidate): string {
  return (candidate.text || candidate.title || candidate.href)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function dateFromText(value: string): string | undefined {
  return value.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i)?.[0] ??
    value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
}

function agentCompatibleRows(result: Record<string, unknown>): unknown[] {
  const direct = arrayValue(result.rows ?? result.records ?? result.result);
  if (direct.length > 0) {
    return direct;
  }
  const nested = isRecord(result.result) ? result.result : undefined;
  return nested ? arrayValue(nested.rows ?? nested.records) : [];
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
