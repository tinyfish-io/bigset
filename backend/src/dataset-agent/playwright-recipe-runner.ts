import vm from "node:vm";

import { emptyMetrics, normalizeDatasetAgentResult } from "./output.js";
import { createDatasetRecipeRunResult } from "./recipe-runtime.js";
import type {
  DatasetRecipeArtifact,
  DatasetRecipeRunInput,
  DatasetRecipeRunResult,
  DatasetRecipeRuntime,
} from "./recipe-types.js";
import type { DatasetAgentEvidence, DatasetAgentRow } from "./types.js";

const DEFAULT_RECIPE_TIMEOUT_MS = 30_000;
const SCRIPT_COMPILE_TIMEOUT_MS = 1_000;
const MAX_ARTIFACT_TEXT_CHARS = 20_000;

export interface DatasetRecipePageLike {
  goto?(url: string): Promise<unknown>;
  content?(): Promise<string>;
  screenshot?(input?: { type?: "png"; fullPage?: boolean }): Promise<unknown>;
  url?(): string;
}

export interface DatasetRecipeBrowserSession {
  page: DatasetRecipePageLike;
  close(): Promise<void>;
  collectArtifacts?(): Promise<DatasetRecipeArtifact[]>;
}

export type DatasetRecipeBrowserFactory =
  () => Promise<DatasetRecipeBrowserSession>;

export interface DatasetRecipeScriptContext {
  page: DatasetRecipePageLike;
  input: DatasetRecipeRunInput["runInput"];
  emitRow(row: Partial<DatasetAgentRow> & {
    cells: Record<string, unknown>;
  }): void;
  addEvidence(evidence: DatasetAgentEvidence): void;
  log(message: string): void;
}

export class PlaywrightRecipeRunner implements DatasetRecipeRuntime {
  private readonly browserFactory: DatasetRecipeBrowserFactory;
  private readonly timeoutMs: number;

  constructor(input: {
    browserFactory?: DatasetRecipeBrowserFactory;
    timeoutMs?: number;
  } = {}) {
    this.browserFactory = input.browserFactory ?? createDefaultPlaywrightSession;
    this.timeoutMs = input.timeoutMs ?? DEFAULT_RECIPE_TIMEOUT_MS;
  }

  async runRecipe(input: DatasetRecipeRunInput): Promise<DatasetRecipeRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const emittedRows: Array<Partial<DatasetAgentRow> & {
      cells: Record<string, unknown>;
    }> = [];
    const sharedEvidence: DatasetAgentEvidence[] = [];
    const logs: string[] = [];
    const artifacts: DatasetRecipeArtifact[] = [];
    let session: DatasetRecipeBrowserSession | undefined;
    let failureMessage: string | undefined;

    try {
      session = await this.browserFactory();
      await runRecipeScriptWithTimeout({
        scriptText: input.recipe.scriptText,
        timeoutMs: this.timeoutMs,
        context: {
          page: session.page,
          input: input.runInput,
          emitRow(row) {
            emittedRows.push(row);
          },
          addEvidence(evidence) {
            sharedEvidence.push(evidence);
          },
          log(message) {
            logs.push(message);
          },
        },
      });
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }

    if (logs.length > 0) {
      artifacts.push({
        kind: "stdout",
        label: "recipe-log",
        content: logs.join("\n").slice(0, MAX_ARTIFACT_TEXT_CHARS),
      });
    }
    if (failureMessage) {
      artifacts.push({
        kind: "stderr",
        label: "recipe-error",
        content: failureMessage,
      });
    }
    if (session?.collectArtifacts) {
      artifacts.push(...await session.collectArtifacts());
    } else if (session?.page) {
      artifacts.push(...await collectDefaultPageArtifacts(session.page));
    }

    await session?.close();

    const normalizedResult = normalizeDatasetAgentResult({
      rawOutput: {
        rows: emittedRows.map((row) => ({
          ...row,
          evidence: row.evidence?.length ? row.evidence : sharedEvidence,
        })),
        validationIssues: failureMessage ? [failureMessage] : [],
      },
      runInput: input.runInput,
      metrics: {
        ...emptyMetrics(),
        browserCalls: session ? 1 : 0,
      },
    });

    return createDatasetRecipeRunResult({
      recipe: input.recipe,
      runInput: input.runInput,
      result: normalizedResult,
      runStatus: failureMessage ? "failed" : "succeeded",
      startedAt,
      completedAt: new Date().toISOString(),
      runtimeMs: Date.now() - startedAtMs,
      artifacts,
    });
  }
}

export function validateDatasetRecipeScript(scriptText: string): void {
  try {
    compileRecipeScript(scriptText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Recipe script must export runDatasetRecipe(context): ${message}`
    );
  }
}

async function runRecipeScriptWithTimeout(input: {
  scriptText: string;
  timeoutMs: number;
  context: DatasetRecipeScriptContext;
}): Promise<void> {
  const runDatasetRecipe = compileRecipeScript(input.scriptText);
  await timeoutPromise(
    Promise.resolve(runDatasetRecipe(input.context)),
    input.timeoutMs
  );
}

function compileRecipeScript(scriptText: string): (
  context: DatasetRecipeScriptContext
) => unknown {
  const moduleContainer = { exports: {} as Record<string, unknown> };
  const sandbox = vm.createContext({
    module: moduleContainer,
    exports: moduleContainer.exports,
    console: {
      log: (...values: unknown[]) => values.join(" "),
    },
    setTimeout,
    clearTimeout,
    Promise,
  });
  const script = new vm.Script(toCommonJsRecipeScript(scriptText));
  script.runInContext(sandbox, { timeout: SCRIPT_COMPILE_TIMEOUT_MS });
  const runDatasetRecipe = moduleContainer.exports.runDatasetRecipe;

  if (typeof runDatasetRecipe !== "function") {
    throw new Error("Recipe script must export runDatasetRecipe(context).");
  }

  return runDatasetRecipe as (context: DatasetRecipeScriptContext) => unknown;
}

function toCommonJsRecipeScript(scriptText: string): string {
  const commonJsText = scriptText
    .replace(
      /export\s+async\s+function\s+runDatasetRecipe\s*\(/,
      "async function runDatasetRecipe("
    )
    .replace(
      /export\s+function\s+runDatasetRecipe\s*\(/,
      "function runDatasetRecipe("
    );

  return [
    "\"use strict\";",
    commonJsText,
    "if (typeof runDatasetRecipe === 'function' && !module.exports.runDatasetRecipe) {",
    "  module.exports.runDatasetRecipe = runDatasetRecipe;",
    "}",
  ].join("\n");
}

async function timeoutPromise<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Recipe timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function collectDefaultPageArtifacts(
  page: DatasetRecipePageLike
): Promise<DatasetRecipeArtifact[]> {
  const artifacts: DatasetRecipeArtifact[] = [];

  if (page.url) {
    artifacts.push({
      kind: "url-history",
      label: "final-url",
      content: page.url(),
    });
  }

  if (page.content) {
    const content = await page.content();
    artifacts.push({
      kind: "dom",
      label: "final-dom",
      content: content.slice(0, MAX_ARTIFACT_TEXT_CHARS),
    });
  }

  if (page.screenshot) {
    const screenshot = await page.screenshot({ type: "png", fullPage: true });
    artifacts.push({
      kind: "screenshot",
      label: "final-screenshot",
      content: screenshotToContent(screenshot),
    });
  }

  return artifacts;
}

function screenshotToContent(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, MAX_ARTIFACT_TEXT_CHARS);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return "";
}

async function createDefaultPlaywrightSession(): Promise<DatasetRecipeBrowserSession> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<Record<string, unknown>>;
  const playwright = await dynamicImport("playwright");
  const chromium = playwright.chromium as {
    launch(input: { headless: boolean }): Promise<{
      newPage(): Promise<DatasetRecipePageLike>;
      close(): Promise<void>;
    }>;
  } | undefined;

  if (!chromium) {
    throw new Error("Playwright chromium launcher is unavailable.");
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  return {
    page,
    close: () => browser.close(),
  };
}
