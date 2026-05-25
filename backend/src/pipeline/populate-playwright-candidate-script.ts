import type {
  PopulateProcessTrace,
  PopulateRuntimeBrowserAction,
  PopulateRuntimeResult,
  PopulateRuntimeTraceStep,
} from "./populate-runtime.js";
import { playwrightCandidateReadinessForRun } from "./populate-playwright-readiness.js";

const MAX_CANDIDATE_ACTIONS = 100;
const MAX_CANDIDATE_SCRIPT_LENGTH = 19_500;
const CANDIDATE_ACTION_LIMITS = [100, 50, 25, 10, 5, 1] as const;

interface PlaywrightCandidateAction {
  action: PopulateRuntimeBrowserAction["action"];
  label: string;
  url?: string;
  selector?: string;
  targetText?: string;
  valueDescription?: string;
}

export function playwrightCandidateScriptForRun(input: {
  result: PopulateRuntimeResult;
}): string | undefined {
  const readiness = playwrightCandidateReadinessForRun(input);
  const processTrace = input.result.debug?.processTrace;
  if (readiness.status !== "ready" || !processTrace) {
    return undefined;
  }

  const actions = actionableBrowserSteps(processTrace)
    .slice(0, MAX_CANDIDATE_ACTIONS)
    .map((step) => ({
      action: step.browserAction!.action,
      label: trimCandidateText(step.label) ?? "browser-action",
      url: trimCandidateText(step.browserAction!.url),
      selector: trimCandidateText(step.browserAction!.selector),
      targetText: trimCandidateText(step.browserAction!.targetText),
      valueDescription: trimCandidateText(step.browserAction!.valueDescription),
    }));
  if (actions.length === 0) {
    return undefined;
  }

  const sourceUrls = sourceUrlsForTrace(processTrace);
  for (const actionLimit of CANDIDATE_ACTION_LIMITS) {
    const limitedActions = actions.slice(0, actionLimit);
    if (limitedActions.length === 0) {
      continue;
    }
    const script = renderPlaywrightCandidateScript({
      actions: limitedActions,
      sourceUrls,
      omittedActionCount: Math.max(0, actions.length - limitedActions.length),
    });
    if (script.length <= MAX_CANDIDATE_SCRIPT_LENGTH) {
      return script;
    }
  }
  return undefined;
}

function actionableBrowserSteps(
  processTrace: PopulateProcessTrace
): PopulateRuntimeTraceStep[] {
  return processTrace.steps.filter((step) => {
    if (step.kind !== "browser" || step.status !== "succeeded") {
      return false;
    }
    const action = step.browserAction;
    if (!action) {
      return false;
    }
    return Boolean(action.url || action.selector || action.targetText);
  });
}

function sourceUrlsForTrace(processTrace: PopulateProcessTrace): string[] {
  return Array.from(new Set([
    ...processTrace.fetchedUrls,
    ...processTrace.sourceArtifacts
      .filter((artifact) => artifact.status === "succeeded")
      .map((artifact) => artifact.url),
  ].filter((url) => /^https?:\/\//i.test(url))));
}

function trimCandidateText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length > 500 ? `${value.slice(0, 500)} [truncated]` : value;
}

function renderPlaywrightCandidateScript(input: {
  actions: PlaywrightCandidateAction[];
  sourceUrls: string[];
  omittedActionCount: number;
}): string {
  return `// Generated from explicit BigSet browser actions.
// Review before promotion to an active cron recipe.
${input.omittedActionCount > 0
    ? `// Omitted ${input.omittedActionCount} lower-priority browser actions to keep artifact size bounded.\n`
    : ""}

const browserActions = ${JSON.stringify(input.actions)};
const sourceUrls = ${JSON.stringify(input.sourceUrls)};

export async function runDatasetRecipe(context) {
  const page = context.page;
  if (!page) {
    throw new Error("runDatasetRecipe requires context.page");
  }

  const notes = [];
  for (const action of browserActions) {
    await replayBrowserAction(page, action, context, notes);
  }

  return {
    rows: [],
    sourceUrls,
    notes,
  };
}

async function replayBrowserAction(page, action, context, notes) {
  switch (action.action) {
    case "navigate":
      if (!action.url) throw new Error(\`navigate action missing url: \${action.label}\`);
      await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return;
    case "click":
      await clickTarget(page, action);
      await waitAfterAction(page);
      return;
    case "type":
      await fillTarget(page, action, context);
      await waitAfterAction(page);
      return;
    case "select":
      await selectTarget(page, action, context);
      await waitAfterAction(page);
      return;
    case "wait":
      await waitAfterAction(page);
      return;
    case "extract":
      await page.waitForLoadState("domcontentloaded");
      return;
    case "screenshot":
      notes.push(\`screenshot requested by action: \${action.label}\`);
      return;
    default:
      if (action.url) {
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
      } else {
        notes.push(\`skipped unknown browser action: \${action.label}\`);
      }
  }
}

async function clickTarget(page, action) {
  if (action.selector) {
    await page.locator(action.selector).first().click();
    return;
  }
  if (action.targetText) {
    await page.getByText(action.targetText, { exact: false }).first().click();
    return;
  }
  if (action.url) {
    await page.goto(action.url, { waitUntil: "domcontentloaded" });
    return;
  }
  throw new Error(\`click action missing selector, targetText, and url: \${action.label}\`);
}

async function fillTarget(page, action, context) {
  const value = inputValueForAction(action, context);
  if (action.selector) {
    await page.locator(action.selector).first().fill(value);
    return;
  }
  if (action.targetText) {
    await page.getByLabel(action.targetText, { exact: false }).first().fill(value);
    return;
  }
  throw new Error(\`type action missing selector or targetText: \${action.label}\`);
}

async function selectTarget(page, action, context) {
  const value = inputValueForAction(action, context);
  if (action.selector) {
    await page.locator(action.selector).first().selectOption(value);
    return;
  }
  if (action.targetText) {
    await page.getByLabel(action.targetText, { exact: false }).first().selectOption(value);
    return;
  }
  throw new Error(\`select action missing selector or targetText: \${action.label}\`);
}

function inputValueForAction(action, context) {
  const inputs = context.inputs ?? {};
  const keys = [action.label, action.selector, action.targetText].filter(Boolean);
  for (const key of keys) {
    if (inputs[key] !== undefined) return String(inputs[key]);
  }
  throw new Error(
    "missing context.inputs value for " +
      action.label +
      (action.valueDescription ? " (" + action.valueDescription + ")" : "")
  );
}

async function waitAfterAction(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    await page.waitForTimeout(500);
  }
}
`;
}
