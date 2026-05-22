export function selfHealingDiagnosticsFromTick({ tick, run }) {
  const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : [];
  const processTrace = processTraceSummaryFromArtifacts(artifacts);
  const playwrightCandidateReadiness = playwrightReadinessFromArtifacts(artifacts);

  return {
    selfHealingAction: tick?.action,
    recipeId: run?.recipeId,
    artifactKinds: artifacts
      .map((artifact) => artifact?.kind)
      .filter((kind) => typeof kind === "string"),
    processTrace,
    playwrightCandidateReadiness,
  };
}

function processTraceSummaryFromArtifacts(artifacts) {
  const trace = parsedJsonArtifact(artifacts, "process-trace");
  if (!trace) {
    return undefined;
  }
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const sourceArtifacts = Array.isArray(trace.sourceArtifacts)
    ? trace.sourceArtifacts
    : [];
  const fetchedUrls = Array.isArray(trace.fetchedUrls) ? trace.fetchedUrls : [];
  const searchQueries = Array.isArray(trace.searchQueries)
    ? trace.searchQueries
    : [];

  return {
    runtime: typeof trace.runtime === "string" ? trace.runtime : "unknown",
    stepCount: steps.length,
    browserStepCount: steps.filter((step) => step?.kind === "browser").length,
    sourceUrlCount: new Set([
      ...fetchedUrls,
      ...sourceArtifacts
        .filter((artifact) => artifact?.status === "succeeded")
        .map((artifact) => artifact?.url),
    ].filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))).size,
    searchQueryCount: searchQueries.length,
    fetchedUrlCount: fetchedUrls.length,
  };
}

function playwrightReadinessFromArtifacts(artifacts) {
  const readiness = parsedJsonArtifact(artifacts, "playwright-candidate-readiness");
  if (!readiness) {
    return undefined;
  }
  return {
    status: readiness.status === "ready" ? "ready" : "not_ready",
    reasons: Array.isArray(readiness.reasons)
      ? readiness.reasons.filter((reason) => typeof reason === "string")
      : [],
    browserStepCount: numberValue(readiness.browserStepCount),
    sourceUrlCount: numberValue(readiness.sourceUrlCount),
  };
}

function parsedJsonArtifact(artifacts, kind) {
  const artifact = artifacts.find((candidate) => candidate?.kind === kind);
  if (!artifact || typeof artifact.content !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(artifact.content);
  } catch {
    return undefined;
  }
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
