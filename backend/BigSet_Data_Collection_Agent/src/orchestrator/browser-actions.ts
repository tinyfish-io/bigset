import {
  browserActionReportSchema,
  type AgentRunRecord,
  type BrowserActionReport,
} from "../models/schemas.js";

const EXPLICIT_BROWSER_ACTION_ARRAY_KEYS = [
  "browser_actions",
  "agent_browser_actions",
] as const;

export function explicitBrowserActionsFromAgentResult(
  input: {
    agentResult: Record<string, unknown> | null;
    pageUrl: string;
  }
): BrowserActionReport[] {
  if (!input.agentResult) {
    return [];
  }

  const actions: BrowserActionReport[] = [];
  for (const key of EXPLICIT_BROWSER_ACTION_ARRAY_KEYS) {
    actions.push(...browserActionsFromValue(input.agentResult[key], input.pageUrl));
  }
  actions.push(...browserActionsFromNavigationSummary({
    value: input.agentResult.navigation,
    pageUrl: input.pageUrl,
    hasExtraction: Boolean(input.agentResult.extraction),
  }));
  return dedupeBrowserActions(actions);
}

export function explicitBrowserActionsFromAgentRuns(
  agentRuns: AgentRunRecord[]
): BrowserActionReport[] {
  return dedupeBrowserActions(
    agentRuns.flatMap((run) => run.browser_actions ?? [])
  );
}

function browserActionsFromValue(
  value: unknown,
  pageUrl: string
): BrowserActionReport[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => browserActionFromValue(item, pageUrl))
      .filter((action): action is BrowserActionReport => Boolean(action));
  }
  const action = browserActionFromValue(value, pageUrl);
  return action ? [action] : [];
}

function browserActionFromValue(
  value: unknown,
  pageUrl: string
): BrowserActionReport | undefined {
  if (typeof value === "string") {
    return browserActionFromString(value, pageUrl);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const parsed = browserActionReportSchema.safeParse(value);
  if (!parsed.success || !hasReplayAnchor(parsed.data)) {
    return undefined;
  }
  return {
    ...parsed.data,
    url: parsed.data.url ?? pageUrl,
  };
}

function browserActionFromString(
  value: string,
  pageUrl: string
): BrowserActionReport | undefined {
  const label = value.trim();
  if (!label) {
    return undefined;
  }
  const url = label.match(/https?:\/\/[^\s,)]+/i)?.[0]
    ?.replace(/[.?!]+$/, "");
  if (url) {
    return {
      action: "navigate",
      url,
      status: "succeeded",
      phase: "navigation",
      label,
    };
  }

  if (/\bextract\b/i.test(label)) {
    return {
      action: "extract",
      url: pageUrl,
      status: "succeeded",
      phase: "extract",
      label,
    };
  }

  const sectionText = targetTextFromNavigationInstruction(label);
  if (sectionText) {
    return {
      action: "click",
      url: pageUrl,
      target_text: sectionText,
      status: "succeeded",
      phase: "navigation",
      label,
    };
  }

  return undefined;
}

function targetTextFromNavigationInstruction(label: string): string | undefined {
  const match = label.match(
    /\b(?:navigate|go)\s+to\s+(?:the\s+)?(.+?)(?:\s+(?:section|tab|category|page|area))?(?:\s+(?:of|on|to|for)\b|[.?!]|$)/i
  );
  const targetText = match?.[1]?.trim();
  return targetText && !/^https?:\/\//i.test(targetText)
    ? targetText
    : undefined;
}

function hasReplayAnchor(action: BrowserActionReport): boolean {
  return Boolean(
    action.url ||
    action.selector ||
    action.target_text ||
    action.targetText
  );
}

function browserActionsFromNavigationSummary(input: {
  value: unknown;
  pageUrl: string;
  hasExtraction: boolean;
}): BrowserActionReport[] {
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
    return [];
  }
  const navigation = input.value as Record<string, unknown>;
  const actions: BrowserActionReport[] = [];
  const initialUrl = stringValue(navigation.initial_url ?? navigation.initialUrl);
  if (initialUrl) {
    actions.push({
      action: "navigate",
      url: initialUrl,
      status: "succeeded",
      phase: "initial",
      label: "agent-navigation-start",
    });
  }

  const categoryClicked = stringValue(
    navigation.category_clicked ?? navigation.categoryClicked
  );
  if (categoryClicked) {
    actions.push({
      action: "click",
      url: initialUrl ?? input.pageUrl,
      target_text: categoryClicked,
      status: "succeeded",
      phase: "navigation",
      label: "agent-click-category",
    });
  }

  const finalUrl = stringValue(navigation.final_url ?? navigation.finalUrl);
  if (finalUrl && finalUrl !== initialUrl) {
    actions.push({
      action: "navigate",
      url: finalUrl,
      status: "succeeded",
      phase: "navigation",
      label: "agent-navigation-final-url",
    });
  }

  if (actions.length > 0 && input.hasExtraction) {
    actions.push({
      action: "extract",
      url: finalUrl ?? initialUrl ?? input.pageUrl,
      status: "succeeded",
      phase: "extract",
      label: "agent-extract-results",
    });
  }

  return actions;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function dedupeBrowserActions(
  actions: BrowserActionReport[]
): BrowserActionReport[] {
  const seen = new Set<string>();
  const deduped: BrowserActionReport[] = [];
  for (const action of actions) {
    const key = JSON.stringify([
      action.action ?? "",
      action.url ?? "",
      action.selector ?? "",
      action.target_text ?? action.targetText ?? "",
      action.status ?? "",
      action.error ?? "",
      action.phase ?? "",
      action.label ?? "",
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }
  return deduped;
}
