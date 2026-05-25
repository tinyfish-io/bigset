import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** @typedef {'orchestrator' | 'investigate'} SessionKind */

/**
 * Benchmark-only trace + artifact writer. Keeps stdout clean for JSON scoring.
 */
export function createBenchmarkTrace(options = {}) {
  const artifactDir = options.artifactDir ?? process.env.BIGSET_BENCHMARK_ARTIFACT_DIR ?? null;
  const debug = options.debug ?? process.env.BIGSET_MASTRA_BENCHMARK_DEBUG === "true";

  const state = {
    artifactDir,
    debug,
    sessions: [],
    inserts: [],
    usageTotal: emptyUsage(),
    usageByKind: {
      orchestrator: emptyUsage(),
      investigate: emptyUsage(),
    },
    nextSessionIndex: 0,
    logSink: [],
  };

  const originalConsoleLog = console.log;
  console.log = (...args) => {
    const line = args.map((arg) => formatLogArg(arg)).join(" ");
    state.logSink.push(line);
    console.error(...args);
  };

  /** @type {(() => object) | null} */
  let payloadSnapshot = null;

  return {
    state,
    setPayloadSnapshot(fn) {
      payloadSnapshot = fn;
    },
    restoreConsole() {
      console.log = originalConsoleLog;
    },
    async initArtifacts(meta) {
      if (!artifactDir) return;
      await mkdir(join(artifactDir, "sessions"), { recursive: true });
      await writeJson(join(artifactDir, "run-meta.json"), {
        ...meta,
        startedAt: new Date().toISOString(),
      });
      if (meta.orchestratorPrompt) {
        await writeText(join(artifactDir, "orchestrator-prompt.txt"), meta.orchestratorPrompt);
      }
      if (meta.userPrompt) {
        await writeText(join(artifactDir, "user-prompt.txt"), meta.userPrompt);
      }
    },
    async recordInsert({ sessionId, entityHint, row }) {
      state.inserts.push({
        sessionId,
        entityHint,
        rowId: row.id,
        data: row.data,
        at: new Date().toISOString(),
      });
      await snapshotPayload(state, payloadSnapshot);
    },
    async recordGenerateSession(input) {
      const usage = usageFromGenerateResult(input.result);
      addUsage(state.usageTotal, usage);
      addUsage(state.usageByKind[input.kind] ?? state.usageByKind.investigate, usage);

      const session = {
        index: ++state.nextSessionIndex,
        id: `session-${String(state.nextSessionIndex).padStart(3, "0")}`,
        kind: input.kind,
        entityHint: input.entityHint ?? null,
        startedAt: input.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(input.startedAt),
        usage,
        stepCount: input.result?.steps?.length ?? 0,
        prompt: input.prompt,
        responseText: input.result?.text ?? "",
        parsed: input.parsed ?? null,
        steps: summarizeSteps(input.result?.steps),
        error: input.error ?? null,
      };
      state.sessions.push(session);
      await persistSessionArtifact(state, session);
      await snapshotPayload(state, payloadSnapshot);
      return session;
    },
    buildPayload(base) {
      return {
        ...base,
        benchmarkTrace: {
          sessionCount: state.sessions.length,
          insertCount: state.inserts.length,
          usage: state.usageTotal,
          usageByKind: state.usageByKind,
          sessions: state.sessions.map((session) => ({
            id: session.id,
            kind: session.kind,
            entityHint: session.entityHint,
            usage: session.usage,
            stepCount: session.stepCount,
            durationMs: session.durationMs,
            inserted: session.parsed?.inserted,
          })),
        },
      };
    },
    async finalize(payload) {
      if (!artifactDir) {
        emitBenchmarkStdout(payload);
        return;
      }

      await writeJson(join(artifactDir, "benchmark-payload.json"), payload);
      await writeJson(join(artifactDir, "rows.json"), payload.rows ?? []);
      await writeJson(join(artifactDir, "sessions-index.json"), state.sessions);
      await writeJson(join(artifactDir, "inserts.json"), state.inserts);
      await writeJson(join(artifactDir, "usage.json"), {
        total: state.usageTotal,
        byKind: state.usageByKind,
        sessions: state.sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          entityHint: s.entityHint,
          usage: s.usage,
        })),
      });
      if (payload.rows?.length) {
        await writeText(
          join(artifactDir, "rows.csv"),
          rowsToCsv(payload.rows, payload.requestedColumns ?? [])
        );
      }
      await writeText(join(artifactDir, "tool-logs.txt"), state.logSink.join("\n"));
      await writeJson(join(artifactDir, "run-report.json"), {
        completedAt: new Date().toISOString(),
        rowCount: payload.rows?.length ?? 0,
        validationIssueCount: payload.validationIssues?.length ?? 0,
        usage: state.usageTotal,
        usageByKind: state.usageByKind,
        metrics: payload.metrics,
        sessions: state.sessions.length,
        inserts: state.inserts.length,
      });

      // Stdout for run-benchmark.mjs must be ONLY this object.
      emitBenchmarkStdout(payload);
      if (debug) {
        console.error(`[benchmark] artifacts written to ${artifactDir}`);
      }
    },
  };
}

export function emitBenchmarkStdout(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function usageFromGenerateResult(result) {
  const candidates = [
    result?.usage,
    result?.totalUsage,
    result?.output?.usage,
  ].filter(Boolean);
  const usage = candidates[0] ?? {};
  const promptTokens = numberValue(
    usage.promptTokens ?? usage.inputTokens ?? usage.prompt_tokens
  );
  const completionTokens = numberValue(
    usage.completionTokens ?? usage.outputTokens ?? usage.completion_tokens
  );
  const totalTokens = numberValue(
    usage.totalTokens ?? usage.total_tokens ?? promptTokens + completionTokens
  );
  return { promptTokens, completionTokens, totalTokens };
}

function addUsage(target, delta) {
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.totalTokens += delta.totalTokens;
}

function summarizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step, index) => {
    const toolName =
      step?.toolName ??
      step?.name ??
      step?.tool?.name ??
      step?.payload?.toolName ??
      null;
    const stepType = step?.type ?? step?.stepType ?? step?.kind ?? "unknown";
    return {
      index,
      stepType,
      toolName,
      input: truncateJson(step?.input ?? step?.args ?? step?.payload?.input),
      output: truncateJson(step?.output ?? step?.result ?? step?.payload?.output),
      usage: usageFromGenerateResult(step),
    };
  });
}

function truncateJson(value, maxLen = 4000) {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= maxLen) return value;
    return `${text.slice(0, maxLen)}…[truncated]`;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

async function persistSessionArtifact(state, session) {
  if (!state.artifactDir) return;
  const slug = safeSlug(session.entityHint ?? session.kind);
  const fileName = `${String(session.index).padStart(3, "0")}-${session.kind}-${slug}.json`;
  await writeJson(join(state.artifactDir, "sessions", fileName), session);
}

function rowsToCsv(rows, columns) {
  const header = ["_row_index", ...columns];
  const lines = [header.join(",")];
  rows.forEach((row, rowIndex) => {
    const cells = row.cells ?? row.data ?? {};
    const values = [
      String(rowIndex),
      ...columns.map((column) => csvEscape(cells[column])),
    ];
    lines.push(values.join(","));
  });
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function safeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "unknown";
}

function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value) {
  await writeFile(path, value);
}

async function snapshotPayload(state, payloadSnapshot) {
  if (!state.artifactDir || typeof payloadSnapshot !== "function") {
    return;
  }
  try {
    await writeJson(
      join(state.artifactDir, "benchmark-payload.json"),
      payloadSnapshot()
    );
  } catch (err) {
    console.error(
      `[benchmark] failed to snapshot payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
