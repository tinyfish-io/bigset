import type {
  PopulateProcessTrace,
  PopulateRuntimeResult,
  PopulateRuntimeTraceStep,
} from "./populate-runtime.js";

export type PopulatePlaywrightCandidateReadinessStatus =
  | "ready"
  | "not_ready";

export interface PopulatePlaywrightCandidateReadiness {
  status: PopulatePlaywrightCandidateReadinessStatus;
  reasons: string[];
  browserStepCount: number;
  sourceUrlCount: number;
}

export function playwrightCandidateReadinessForRun(input: {
  result: PopulateRuntimeResult;
}): PopulatePlaywrightCandidateReadiness {
  const processTrace = input.result.debug?.processTrace;
  const reasons: string[] = [];

  if (!processTrace) {
    reasons.push("Process trace is missing.");
  }
  if (hasAgentDisabledCapabilityDiagnostic(input.result)) {
    reasons.push(
      "TinyFish Agent/browser follow-up was required but disabled for this run."
    );
  }

  const browserSteps = processTrace
    ? actionableBrowserSteps(processTrace)
    : [];
  if (browserSteps.length === 0) {
    reasons.push(
      "Trace has no actionable browser steps with URL/selector/target data."
    );
  }

  const sourceUrlCount = processTrace
    ? sourceUrlCountForTrace(processTrace)
    : 0;
  if (sourceUrlCount === 0) {
    reasons.push("Trace has no source URLs to anchor a replay script.");
  }

  return {
    status: reasons.length === 0 ? "ready" : "not_ready",
    reasons,
    browserStepCount: browserSteps.length,
    sourceUrlCount,
  };
}

function hasAgentDisabledCapabilityDiagnostic(
  result: PopulateRuntimeResult
): boolean {
  const diagnostics = [
    ...result.validationIssues,
    ...(result.debug?.notes ?? []),
  ];
  return diagnostics.some((diagnostic) =>
    /Capability diagnostic: TinyFish Agent disabled/i.test(diagnostic)
  );
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
    return Boolean(
      action.url ||
      action.selector ||
      action.targetText
    );
  });
}

function sourceUrlCountForTrace(processTrace: PopulateProcessTrace): number {
  return new Set([
    ...processTrace.fetchedUrls,
    ...processTrace.sourceArtifacts
      .filter((artifact) => artifact.status === "succeeded")
      .map((artifact) => artifact.url),
  ].filter((url) => /^https?:\/\//i.test(url))).size;
}
