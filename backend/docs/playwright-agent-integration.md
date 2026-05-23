# Playwright agent integration guide (Edward)

This guide explains how to plug a **Playwright-based browser agent** into Bigset's populate pipeline as a drop-in alternative to Tinyfish Agent for URLs that were previously visited by Tinyfish.

## Contract (must match Tinyfish)

Your agent must implement the same **job** and **result** types as Tinyfish:

```typescript
// backend/src/pipeline/populate-browser-agent.ts

interface BrowserAgentJob {
  url: string;
  goal: string; // natural-language instructions (column hints + suggested action)
}

interface BrowserAgentRunResult {
  run_id: string | null;
  status: string;       // e.g. COMPLETED | FAILED | TIMEOUT
  result: Record<string, unknown> | null;
  error: string | null;
}
```

Playwright receives **extra optional fields** on the job:

```typescript
interface PlaywrightAgentJob extends BrowserAgentJob {
  emitted_process?: Record<string, unknown> | null; // from collection memory
  prior_tinyfish_run_id?: string | null;
  repair_loop?: number;
}
```

The populate pipeline passes `emitted_process` when replaying a URL that already has a Tinyfish visit in memory. Your script should treat that object as the blueprint for navigation (selectors, clicks, waits) instead of re-discovering the page from scratch.

After your agent returns, **`extractFromTinyfishAgentResult`** runs the same LLM extraction step used for Tinyfish—so `result` should contain whatever that extractor expects (typically page text, structured fields, or HTML snippets in a consistent JSON shape).

## Where to plug in

### Option A — Implement the dock file (recommended)

Edit:

`backend/src/pipeline/populate-playwright-agent.ts`

Replace `runPlaywrightAgent` with your implementation:

```typescript
export async function runPlaywrightAgent(
  job: PlaywrightAgentJob,
  config: PopulatePlaywrightAgentConfig
): Promise<BrowserAgentRunResult> {
  const script = await compilePlaywrightScript(job.emitted_process);
  const output = await runPlaywrightScript({ url: job.url, script, timeoutMs: config.pollTimeoutMs });
  return {
    run_id: output.id ?? null,
    status: output.ok ? "COMPLETED" : "FAILED",
    result: output.payload,
    error: output.error ?? null,
  };
}
```

### Option B — Inject via test hooks / custom runner

Pass a custom batch function when calling `runParallelPopulatePhase`:

```typescript
await runParallelPopulatePhase({
  // ...
  hooks: {
    runPlaywrightAgentsBatch: myPlaywrightBatch,
  },
});
```

## When Playwright runs

| `POPULATE_ENABLE_PLAYWRIGHT_AGENT` | Memory has Tinyfish `emitted_process` for URL | Behavior |
|-----------------------------------|-----------------------------------------------|----------|
| `false` (default) | any | Playwright **never** runs; pipeline unchanged. |
| `true` | no | Tinyfish runs (if enabled); visit recorded to memory. |
| `true` | yes | **Playwright** runs instead of Tinyfish for that URL. |

First populate of a dataset: only Tinyfish (if triage requires agent). Second populate (with Playwright enabled): deferred URLs with saved process use your agent.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POPULATE_ENABLE_PLAYWRIGHT_AGENT` | `false` | Master switch. |
| `POPULATE_MAX_PLAYWRIGHT_AGENT_RUNS` | `5` | Max Playwright jobs per populate run. |
| `POPULATE_PLAYWRIGHT_AGENT_POLL_TIMEOUT_MS` | `480000` | Passed via config to your implementation. |
| `POPULATE_PLAYWRIGHT_AGENT_POLL_INTERVAL_MS` | `3000` | Reserved for polling wrappers. |
| `POPULATE_ENABLE_COLLECTION_MEMORY` | `true` | Must stay on to pass `emitted_process`. |
| `POPULATE_COLLECTION_MEMORY_DIR` | `.bigset/collection-memory` | Where `{datasetId}.json` is stored. |

## Changing inputs

| What to change | Where |
|----------------|-------|
| Goal / column hints | `buildTinyfishAgentGoal` in `populate-tinyfish-agent.ts` (shared for both agents). |
| When agent is required | `statusNeedsTinyfishAgent` in `populate-source-status.ts`. |
| Agent priority / budget | `agentPriorityScore`, `maxPlaywrightAgentRuns` in `populate-parallel-config.ts`. |
| Extra job fields | Extend `PlaywrightAgentJob` in `populate-browser-agent.ts` and map them in `populate-parallel.ts` (Playwright job builder). |
| Extraction from agent output | `populate-extract-from-agent.ts`. |

If you add fields to `PlaywrightAgentJob`, update the job builder in `populate-parallel.ts` (search for `Playwright agent budget`).

## Reading memory manually

```typescript
import { loadCollectionMemory, latestTinyfishEmittedProcess } from "../src/pipeline/collection-memory/index.js";

const memory = await loadCollectionMemory(".bigset/collection-memory", datasetId);
const process = memory ? latestTinyfishEmittedProcess(memory, "https://example.com/page") : undefined;
```

Each `agent_visited_urls[]` entry includes:

- `provider`: `"tinyfish"` | `"playwright"`
- `goal`, `status`, `run_id`, `visited_at`
- `emitted_process`: snapshot for replay
- `triage_status`, `suggested_action`: context from triage LLM

## Local dev checklist

1. Run a populate with Tinyfish agent enabled → confirm `.bigset/collection-memory/{datasetId}.json` has `emitted_process` entries.
2. Implement `runPlaywrightAgent`.
3. Set `POPULATE_ENABLE_PLAYWRIGHT_AGENT=true`.
4. Clear & Populate again on the same dataset → Playwright should receive `emitted_process` on matching URLs.

## See also

- [tinyfish-emitted-process-capture.md](./tinyfish-emitted-process-capture.md) — prompt guide for richer `emitted_process` payloads.
- [populate-collection-architecture.md](./populate-collection-architecture.md) — full pipeline diagram.
