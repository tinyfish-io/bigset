import type {
  PopulateRuntimeBrowserAction,
  PopulateRuntimeTraceStep,
} from "./populate-runtime.js";
import { TinyFish } from "@tiny-fish/sdk";

export type TinyFishRecordedTraceStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "unknown";

export interface TinyFishSseEvent {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface TinyFishArtifactRef {
  kind: "screenshot" | "html" | "recording" | "streaming" | "unknown";
  url?: string;
  endpoint?: string;
  stepId?: string;
  label?: string;
}

export interface TinyFishRunStep {
  index: number;
  id?: string;
  action?: string;
  status?: string;
  urlBefore?: string;
  urlAfter?: string;
  selector?: string;
  targetText?: string;
  valueSummary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  artifactRefs: TinyFishArtifactRef[];
}

export interface TinyFishRecordedTrace {
  provider: "tinyfish";
  sourceUrl: string;
  goal: string;
  runId: string | null;
  status: TinyFishRecordedTraceStatus;
  sseEvents: TinyFishSseEvent[];
  runSteps: TinyFishRunStep[];
  artifactRefs: TinyFishArtifactRef[];
  finalResult: Record<string, unknown> | null;
  normalizedBrowserActions: PopulateRuntimeBrowserAction[];
  diagnostics: string[];
}

export interface TinyFishTraceRecorderClient {
  runAgent(input: {
    sourceUrl: string;
    goal: string;
    captureHtml: boolean;
    captureScreenshots: boolean;
    maxDurationSeconds: number;
    maxAgentSteps: number;
  }): Promise<{
    runId?: string | null;
    status?: string;
    finalResult?: Record<string, unknown> | null;
    sseEvents?: unknown[];
    runDetail?: Record<string, unknown> | null;
    diagnostics?: string[];
  }>;
  getRun?(runId: string): Promise<Record<string, unknown> | null>;
}

export function createTinyFishTraceRecorderClient(input: {
  apiKey: string;
  pollIntervalMs?: number;
  baseUrl?: string;
}): TinyFishTraceRecorderClient {
  const baseURL = input.baseUrl ?? "https://agent.tinyfish.ai";
  const client = new TinyFish({ apiKey: input.apiKey, baseURL });
  const pollIntervalMs = input.pollIntervalMs ?? 3_000;
  const rawApiClient = createTinyFishRawApiClient({
    apiKey: input.apiKey,
    baseUrl: baseURL,
  });
  return {
    async runAgent(runInput) {
      return runAgentWithStreamFirst({
        client,
        rawApiClient,
        pollIntervalMs,
        runInput,
      });
    },
    async getRun(runId) {
      return rawApiClient.getRun(runId);
    },
  };
}

function createTinyFishRawApiClient(input: {
  apiKey: string;
  baseUrl: string;
}) {
  return {
    async getRun(runId: string): Promise<Record<string, unknown> | null> {
      const response = await fetch(
        `${input.baseUrl}/v1/runs/${encodeURIComponent(runId)}`,
        {
          headers: {
            "X-API-Key": input.apiKey,
            Accept: "application/json",
          },
        }
      );
      if (!response.ok) {
        return null;
      }
      return recordValue(await response.json().catch(() => null)) ?? null;
    },
  };
}

async function runAgentWithStreamFirst(input: {
  client: TinyFish;
  rawApiClient: ReturnType<typeof createTinyFishRawApiClient>;
  pollIntervalMs: number;
  runInput: Parameters<TinyFishTraceRecorderClient["runAgent"]>[0];
}): ReturnType<TinyFishTraceRecorderClient["runAgent"]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.runInput.maxDurationSeconds * 1_000
  );
  const sseEvents: unknown[] = [];
  let runId: string | null = null;
  let status: string | undefined;
  let finalResult: Record<string, unknown> | null = null;

  try {
    const stream = await input.client.agent.stream(
      {
        url: input.runInput.sourceUrl,
        goal: input.runInput.goal,
      },
      { signal: controller.signal }
    );
    for await (const event of stream) {
      const eventRecord = recordValue(event);
      sseEvents.push(event);
      runId = stringValue(eventRecord?.run_id) ?? runId;
      if (eventRecord?.type === "COMPLETE") {
        status = stringValue(eventRecord.status) ?? status;
        finalResult = recordValue(eventRecord.result) ?? finalResult;
        await stream.close().catch(() => undefined);
        break;
      }
    }
  } catch (err) {
    const diagnostic = err instanceof Error ? err.message : String(err);
    if (!controller.signal.aborted || !runId) {
      clearTimeout(timeout);
      return runAgentWithQueueFallback({
        client: input.client,
        rawApiClient: input.rawApiClient,
        pollIntervalMs: input.pollIntervalMs,
        runInput: input.runInput,
        initialDiagnostics: [diagnostic],
      });
    }
    status = "TIMEOUT";
  } finally {
    clearTimeout(timeout);
  }

  const runDetail = runId ? await input.rawApiClient.getRun(runId) : null;
  const runDetailStatus = stringValue(runDetail?.status);
  const finalStatus = status === "TIMEOUT" && runDetailStatus
    ? runDetailStatus
    : status ?? runDetailStatus ?? "UNKNOWN";
  return {
    runId,
    status: finalStatus,
    finalResult: finalResult ?? recordValue(runDetail?.result) ?? null,
    sseEvents,
    runDetail,
    diagnostics: controller.signal.aborted && finalStatus === "TIMEOUT"
      ? [`TinyFish Agent stream timed out after ${input.runInput.maxDurationSeconds}s.`]
      : [],
  };
}

async function runAgentWithQueueFallback(input: {
  client: TinyFish;
  rawApiClient: ReturnType<typeof createTinyFishRawApiClient>;
  pollIntervalMs: number;
  runInput: Parameters<TinyFishTraceRecorderClient["runAgent"]>[0];
  initialDiagnostics?: string[];
}): ReturnType<TinyFishTraceRecorderClient["runAgent"]> {
  const queued = await input.client.agent.queue({
    url: input.runInput.sourceUrl,
    goal: input.runInput.goal,
  });
  if (queued.error || !queued.run_id) {
    return {
      runId: queued.run_id ?? null,
      status: "FAILED",
      finalResult: null,
      diagnostics: [
        ...(input.initialDiagnostics ?? []),
        queued.error?.message ?? "TinyFish Agent queue returned no run id.",
      ],
    };
  }

  const startedAt = Date.now();
  let runDetail: Record<string, unknown> | null = null;
  while (Date.now() - startedAt < input.runInput.maxDurationSeconds * 1_000) {
    runDetail = await input.rawApiClient.getRun(queued.run_id);
    const status = String(runDetail?.status ?? "");
    if (/COMPLETED|FAILED|CANCELLED|CANCELED/i.test(status)) {
      const error = recordValue(runDetail?.error);
      return {
        runId: queued.run_id,
        status,
        runDetail,
        finalResult: recordValue(runDetail?.result) ?? null,
        diagnostics: [
          ...(input.initialDiagnostics ?? []),
          ...(stringValue(error?.message) ? [stringValue(error?.message)!] : []),
        ],
      };
    }
    await sleep(input.pollIntervalMs);
  }

  return {
    runId: queued.run_id,
    status: "TIMEOUT",
    runDetail,
    finalResult: null,
    diagnostics: [
      ...(input.initialDiagnostics ?? []),
      `TinyFish Agent run timed out after ${input.runInput.maxDurationSeconds}s.`,
    ],
  };
}

export async function recordTinyFishTrace(input: {
  sourceUrl: string;
  goal: string;
  captureHtml: boolean;
  captureScreenshots: boolean;
  maxDurationSeconds: number;
  maxAgentSteps: number;
  client: TinyFishTraceRecorderClient;
}): Promise<TinyFishRecordedTrace> {
  const run = await input.client.runAgent({
    sourceUrl: input.sourceUrl,
    goal: input.goal,
    captureHtml: input.captureHtml,
    captureScreenshots: input.captureScreenshots,
    maxDurationSeconds: input.maxDurationSeconds,
    maxAgentSteps: input.maxAgentSteps,
  });
  const runId = stringValue(run.runId) ?? stringValue(run.runDetail?.run_id) ?? null;
  const runDetail =
    run.runDetail ??
    (runId && input.client.getRun ? await input.client.getRun(runId) : null);

  return normalizeTinyFishRecordedTrace({
    sourceUrl: input.sourceUrl,
    goal: input.goal,
    runId,
    status: run.status ?? stringValue(runDetail?.status),
    sseEvents: run.sseEvents ?? [],
    runDetail,
    finalResult:
      run.finalResult ??
      recordValue(runDetail?.result) ??
      null,
    diagnostics: run.diagnostics ?? [],
  });
}

export function normalizeTinyFishRecordedTrace(input: {
  sourceUrl: string;
  goal: string;
  runId?: string | null;
  status?: string;
  sseEvents?: unknown[];
  runDetail?: Record<string, unknown> | null;
  finalResult?: Record<string, unknown> | null;
  diagnostics?: string[];
}): TinyFishRecordedTrace {
  const runSteps = runStepsFromRunDetail(input.runDetail);
  const artifactRefs = dedupeArtifactRefs([
    ...artifactRefsFromRunDetail(input.runDetail, input.runId ?? null),
    ...runSteps.flatMap((step) => step.artifactRefs),
  ]);
  const normalizedBrowserActions = dedupeBrowserActions([
    ...runSteps
      .map((step) => browserActionFromRunStep(step, input.sourceUrl))
      .filter((action): action is PopulateRuntimeBrowserAction => Boolean(action)),
    ...browserActionsFromAgentResult(input.finalResult),
  ]);

  return {
    provider: "tinyfish",
    sourceUrl: input.sourceUrl,
    goal: input.goal,
    runId: input.runId ?? stringValue(input.runDetail?.run_id) ?? null,
    status: normalizeTraceStatus(input.status ?? stringValue(input.runDetail?.status)),
    sseEvents: (input.sseEvents ?? []).map(normalizeSseEvent),
    runSteps,
    artifactRefs,
    finalResult: input.finalResult ?? null,
    normalizedBrowserActions,
    diagnostics: [
      ...(input.diagnostics ?? []),
      ...(normalizedBrowserActions.length === 0
        ? ["TinyFish trace contains no explicit replayable browser actions."]
        : []),
    ],
  };
}

export function tinyFishTraceProcessSteps(
  trace: TinyFishRecordedTrace
): PopulateRuntimeTraceStep[] {
  const agentSteps: PopulateRuntimeTraceStep[] = [{
    kind: "agent",
    label: "tinyfish-agent-run",
    status: trace.status === "completed" ? "succeeded" : "failed",
    input: {
      url: trace.sourceUrl,
      runId: trace.runId,
      goalCharacters: trace.goal.length,
    },
    output: {
      sseEventCount: trace.sseEvents.length,
      runStepCount: trace.runSteps.length,
      artifactRefCount: trace.artifactRefs.length,
      browserActionCount: trace.normalizedBrowserActions.length,
    },
    error: trace.status === "completed" ? undefined : trace.diagnostics[0],
  }];

  const browserSteps = trace.normalizedBrowserActions.map((action, index) => ({
    kind: "browser" as const,
    label: `tinyfish-browser-${action.action}-${index + 1}`,
    status: "succeeded" as const,
    input: {
      url: action.url,
      selector: action.selector,
      targetText: action.targetText,
    },
    browserAction: action,
  }));

  return [...agentSteps, ...browserSteps];
}

function runStepsFromRunDetail(
  runDetail: Record<string, unknown> | null | undefined
): TinyFishRunStep[] {
  const rawSteps = arrayValue(runDetail?.steps);
  return rawSteps
    .map((step, index) => runStepFromUnknown(step, index))
    .filter((step): step is TinyFishRunStep => Boolean(step));
}

function runStepFromUnknown(
  value: unknown,
  index: number
): TinyFishRunStep | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = firstStringAtPaths(value, [["id"], ["step_id"], ["stepId"]]);
  return {
    index,
    id,
    action: firstStringAtPaths(value, [
      ["action"],
      ["type"],
      ["kind"],
      ["operation"],
      ["description"],
      ["summary"],
      ["name"],
    ]),
    status: firstStringAtPaths(value, [["status"], ["state"], ["outcome"]]),
    urlBefore: firstStringAtPaths(value, [
      ["url_before"],
      ["urlBefore"],
      ["before", "url"],
      ["input", "url_before"],
    ]),
    urlAfter: firstStringAtPaths(value, [
      ["url_after"],
      ["urlAfter"],
      ["current_url"],
      ["currentUrl"],
      ["url"],
      ["page_url"],
      ["pageUrl"],
      ["after", "url"],
      ["input", "url"],
      ["args", "url"],
    ]),
    selector: firstStringAtPaths(value, [
      ["selector"],
      ["locator"],
      ["target", "selector"],
      ["element", "selector"],
      ["input", "selector"],
      ["args", "selector"],
    ]),
    targetText: firstStringAtPaths(value, [
      ["target_text"],
      ["targetText"],
      ["target", "text"],
      ["element", "text"],
      ["text"],
      ["label"],
    ]),
    valueSummary: safeValueSummary(value),
    error: errorMessageFromRecord(value),
    startedAt: firstStringAtPaths(value, [["started_at"], ["startedAt"]]),
    completedAt: firstStringAtPaths(value, [["completed_at"], ["completedAt"]]),
    durationMs: numberValueAtPaths(value, [["duration_ms"], ["durationMs"], ["duration"]]),
    artifactRefs: artifactRefsFromStep(value, id),
  };
}

function browserActionFromRunStep(
  step: TinyFishRunStep,
  fallbackSourceUrl?: string
): PopulateRuntimeBrowserAction | undefined {
  const action = normalizeBrowserActionKind(step.action);
  if (!action) {
    return undefined;
  }
  const url =
    step.urlAfter ??
    step.urlBefore ??
    (action === "navigate" || action === "extract" || action === "screenshot"
      ? fallbackSourceUrl
      : undefined);
  if (!url && !step.selector && !step.targetText) {
    return undefined;
  }
  return {
    action,
    url,
    selector: step.selector,
    targetText: step.targetText,
    valueDescription: step.valueSummary,
  };
}

function browserActionsFromAgentResult(
  result: Record<string, unknown> | null | undefined
): PopulateRuntimeBrowserAction[] {
  if (!result) {
    return [];
  }
  const rawActions = [
    ...arrayValue(result.browser_actions),
    ...arrayValue(result.agent_browser_actions),
    ...agentCompatibleRows(result).flatMap((row) => {
      if (!isRecord(row)) return [];
      return [
        ...arrayValue(row.browser_actions),
        ...arrayValue(row.agent_browser_actions),
      ];
    }),
  ];
  return rawActions
    .map(browserActionFromUnknown)
    .filter((action): action is PopulateRuntimeBrowserAction => Boolean(action));
}

function browserActionFromUnknown(value: unknown): PopulateRuntimeBrowserAction | undefined {
  if (typeof value === "string") {
    const action = normalizeBrowserActionKind(value);
    if (!action) {
      return undefined;
    }
    const url = value.match(/https?:\/\/[^\s)]+/i)?.[0];
    const targetText = targetTextFromActionString(value);
    if (!url && !targetText) {
      return undefined;
    }
    return {
      action,
      url,
      targetText,
    };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const action = normalizeBrowserActionKind(
    firstStringAtPaths(value, [["action"], ["kind"], ["type"], ["name"], ["label"]])
  );
  if (!action) {
    return undefined;
  }
  const targetText = firstStringAtPaths(value, [
    ["targetText"],
    ["target_text"],
    ["target", "text"],
    ["label"],
  ]);
  const browserAction = {
    action,
    url: firstStringAtPaths(value, [["url"], ["pageUrl"], ["page_url"], ["href"]]),
    selector: firstStringAtPaths(value, [["selector"], ["locator"]]),
    targetText,
    valueDescription: safeValueSummary(value),
  };
  return browserAction.url || browserAction.selector || browserAction.targetText
    ? browserAction
    : undefined;
}

function normalizeBrowserActionKind(
  value: string | undefined
): PopulateRuntimeBrowserAction["action"] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/\b(goto|go to|navigate|visit|open)\b/.test(normalized)) return "navigate";
  if (/\b(click|tap|press)\b/.test(normalized)) return "click";
  if (/\b(type|fill|input|enter)\b/.test(normalized)) return "type";
  if (/\b(select|choose)\b/.test(normalized)) return "select";
  if (/\b(wait|pause)\b/.test(normalized)) return "wait";
  if (/\b(extract|scrape|read|collect)\b/.test(normalized)) return "extract";
  if (/\b(screenshot|capture)\b/.test(normalized)) return "screenshot";
  return undefined;
}

function artifactRefsFromRunDetail(
  runDetail: Record<string, unknown> | null | undefined,
  runId: string | null
): TinyFishArtifactRef[] {
  if (!runDetail) {
    return [];
  }
  const refs: TinyFishArtifactRef[] = [];
  for (const key of ["streaming_url", "streamingUrl"] as const) {
    const url = stringValue(runDetail[key]);
    if (url) refs.push({ kind: "streaming", url, label: key });
  }
  for (const key of ["recording_url", "recordingUrl"] as const) {
    const url = stringValue(runDetail[key]);
    if (url) refs.push({ kind: "recording", url, label: key });
  }
  for (const artifact of [
    ...arrayValue(runDetail.capture_artifacts),
    ...arrayValue(runDetail.captureArtifacts),
    ...arrayValue(runDetail.artifacts),
  ]) {
    if (!isRecord(artifact)) {
      continue;
    }
    refs.push({
      kind: artifactKindFromString(firstStringAtPaths(artifact, [["kind"], ["type"]])),
      url: firstStringAtPaths(artifact, [["url"], ["href"]]),
      endpoint: firstStringAtPaths(artifact, [["endpoint"]]),
      stepId: firstStringAtPaths(artifact, [["step_id"], ["stepId"]]),
      label: firstStringAtPaths(artifact, [["label"], ["name"]]),
    });
  }
  if (runId) {
    refs.push({
      kind: "html",
      endpoint: `/v1/runs/${encodeURIComponent(runId)}/steps/{stepId}/html`,
      label: "documented-step-html-endpoint-template",
    });
    refs.push({
      kind: "screenshot",
      endpoint: `/v1/runs/${encodeURIComponent(runId)}/steps/{stepId}/screenshot`,
      label: "documented-step-screenshot-endpoint-template",
    });
  }
  return refs;
}

function artifactRefsFromStep(
  step: Record<string, unknown>,
  stepId: string | undefined
): TinyFishArtifactRef[] {
  const refs: TinyFishArtifactRef[] = [];
  for (const key of ["screenshot_url", "screenshotUrl"] as const) {
    const url = stringValue(step[key]);
    if (url) refs.push({ kind: "screenshot", url, stepId, label: key });
  }
  for (const key of ["screenshot"] as const) {
    const url = stringValue(step[key]);
    if (url) refs.push({ kind: "screenshot", url, stepId, label: key });
  }
  for (const key of ["html_url", "htmlUrl"] as const) {
    const url = stringValue(step[key]);
    if (url) refs.push({ kind: "html", url, stepId, label: key });
  }
  for (const key of ["html"] as const) {
    const url = stringValue(step[key]);
    if (url) refs.push({ kind: "html", url, stepId, label: key });
  }
  return refs;
}

function normalizeSseEvent(value: unknown): TinyFishSseEvent {
  if (!isRecord(value)) {
    return {
      type: "UNKNOWN",
      message: typeof value === "string" ? value.slice(0, 500) : undefined,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    type: firstStringAtPaths(value, [["type"], ["event"], ["name"]]) ?? "UNKNOWN",
    message: firstStringAtPaths(value, [
      ["message"],
      ["text"],
      ["purpose"],
      ["data", "message"],
    ]),
    data: redactedSseData(value),
    createdAt:
      firstStringAtPaths(value, [["createdAt"], ["created_at"], ["timestamp"]]) ??
      new Date().toISOString(),
  };
}

function normalizeTraceStatus(value: string | undefined): TinyFishRecordedTraceStatus {
  const normalized = value?.toLowerCase() ?? "";
  if (/complete|completed|success|succeeded/.test(normalized)) return "completed";
  if (/fail|error/.test(normalized)) return "failed";
  if (/cancel/.test(normalized)) return "cancelled";
  if (/timeout|timed_out/.test(normalized)) return "timed_out";
  return "unknown";
}

function artifactKindFromString(value: string | undefined): TinyFishArtifactRef["kind"] {
  const normalized = value?.toLowerCase() ?? "";
  if (/screenshot|image|png|jpeg|jpg/.test(normalized)) return "screenshot";
  if (/html|dom/.test(normalized)) return "html";
  if (/recording|video/.test(normalized)) return "recording";
  if (/stream/.test(normalized)) return "streaming";
  return "unknown";
}

function targetTextFromActionString(value: string): string | undefined {
  const quoted = value.match(/["'“”]([^"'“”]{2,120})["'“”]/)?.[1];
  if (quoted) {
    return quoted;
  }
  const section = value.match(/\b(?:click|select|choose|press)\s+(?:the\s+)?([^.,;]{2,80})/i)?.[1];
  return section?.trim();
}

function safeValueSummary(record: Record<string, unknown>): string | undefined {
  const raw = firstStringAtPaths(record, [
    ["value_description"],
    ["valueDescription"],
    ["value"],
    ["text"],
    ["input", "value"],
    ["args", "value"],
  ]);
  if (!raw) {
    return undefined;
  }
  if (/(password|token|secret|key|cookie|auth)/i.test(raw)) {
    return "redacted sensitive value";
  }
  return raw.length > 80 ? `redacted typed value (${raw.length} chars)` : raw;
}

function errorMessageFromRecord(record: Record<string, unknown>): string | undefined {
  const raw = valueAtFirstPath(record, [
    ["error"],
    ["failure"],
    ["failure_reason"],
    ["failureReason"],
    ["result", "error"],
  ]);
  if (typeof raw === "string") {
    return raw.slice(0, 500);
  }
  if (isRecord(raw) && typeof raw.message === "string") {
    return raw.message.slice(0, 500);
  }
  return undefined;
}

function dedupeArtifactRefs(refs: TinyFishArtifactRef[]): TinyFishArtifactRef[] {
  const seen = new Set<string>();
  const deduped: TinyFishArtifactRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify([ref.kind, ref.url, ref.endpoint, ref.stepId, ref.label]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

function dedupeBrowserActions(
  actions: PopulateRuntimeBrowserAction[]
): PopulateRuntimeBrowserAction[] {
  const seen = new Set<string>();
  const deduped: PopulateRuntimeBrowserAction[] = [];
  for (const action of actions) {
    const key = JSON.stringify([
      action.action,
      action.url,
      action.selector,
      action.targetText,
      action.valueDescription,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(action);
  }
  return deduped;
}

function firstStringAtPaths(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[]
): string | undefined {
  for (const path of paths) {
    const value = valueAtPath(record, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 500);
    }
  }
  return undefined;
}

function numberValueAtPaths(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[]
): number | undefined {
  for (const path of paths) {
    const value = valueAtPath(record, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function valueAtFirstPath(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[]
): unknown {
  for (const path of paths) {
    const value = valueAtPath(record, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function valueAtPath(
  record: Record<string, unknown>,
  path: readonly string[]
): unknown {
  let value: unknown = record;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

function redactedSseData(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const safeEntries = Object.entries(value)
    .filter(([key]) => !/streaming|url|token|secret|key|cookie|auth/i.test(key))
    .filter(([, entryValue]) =>
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean"
    );
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

function agentCompatibleRows(result: Record<string, unknown>): unknown[] {
  const direct = arrayValue(result.rows ?? result.records ?? result.result);
  if (direct.length > 0) {
    return direct;
  }
  const nested = recordValue(result.result);
  return nested ? arrayValue(nested.rows ?? nested.records) : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
