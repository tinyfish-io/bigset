# Dataset Agent Benchmark

Shared harness for scoring the Mastra populate stack (orchestrator + `investigate_row` subagents) against a fixed prompt pack.

## Run Mastra Populate

```bash
cd backend && npm ci

node benchmarks/dataset-agent/run-benchmark.mjs \
  --system mastra='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs'
```

Requires `OPENROUTER_API_KEY` and `TINYFISH_API_KEY` in `.env` / `backend/.env.local`.

Open-ended prompts are slow (many subagent calls). Use a longer timeout when needed:

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --timeout-ms 1800000 \
  --prompt-ids yc-recent-batch-companies \
  --system mastra='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs'
```

## Why stdout used to look empty

Production `search_web` / `fetch_page` log with `console.log`, which used to fill **stdout** and break JSON parsing. The adapter now:

1. Redirects all `console.log` to **stderr** during the run
2. Writes **only** the benchmark JSON to stdout via `process.stdout.write`
3. Snapshots `benchmark-payload.json` under the artifact dir after each subagent session and row insert (survives timeouts)

If stdout still cannot be parsed, `run-benchmark.mjs` falls back to `benchmark-payload.json` in the prompt artifact folder.

## Token usage (requirement 1)

Each orchestrator and investigate `agent.generate` call records:

- Per-session `usage` in `sessions/<nnn>-<kind>-<entity>.json`
- Rollups in `usage.json` and `benchmarkTrace.usage` / `usageByKind` inside the stdout payload

## Rows for scoring (requirement 2)

Rows are collected in an **in-memory store** inside the adapter (same shape as production inserts, without Convex). Scoring uses:

- `rows` in stdout / `benchmark-payload.json`
- `rows.json`, `rows.csv` in the artifact directory

## Stage artifacts (requirement 3)

Each prompt run writes under `benchmark-results/<run>/mastra/<nn>-<prompt-id>/`:

| File | Contents |
|------|----------|
| `user-prompt.txt` | Benchmark prompt text |
| `orchestrator-prompt.txt` | Full prompt passed to populate agent |
| `run-meta.json` | ids, columns, step limits |
| `sessions/001-orchestrator.json` | Orchestrator prompt, steps summary, usage, response |
| `sessions/002-investigate-<entity>.json` | Per-lead subagent prompt, parsed INSERTED/SUMMARY/CLUES/REASON, steps, usage |
| `inserts.json` | Each `insert_row` with session + cell data |
| `rows.json` / `rows.csv` | Final rows for review |
| `usage.json` | Total + per-kind + per-session token totals |
| `tool-logs.txt` | Redirected web-tool log lines |
| `run-report.json` | High-level run summary |
| `benchmark-payload.json` | Same object as stdout (updated incrementally) |

Set `BIGSET_MASTRA_BENCHMARK_DEBUG=true` to log the artifact path on stderr.

## Optional env

| Variable | Default | Purpose |
|----------|---------|---------|
| `BIGSET_MASTRA_BENCHMARK_MAX_STEPS` | `80` | Orchestrator step budget |
| `BIGSET_MASTRA_BENCHMARK_TARGET_ROWS` | `20` | Target rows mentioned in prompt |

## Smoke + unit tests

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts \
  --system smoke='node benchmarks/dataset-agent/adapters/smoke-adapter.mjs'

node --test benchmarks/dataset-agent/run-benchmark.test.mjs
```

## Output contract (stdout)

```json
{
  "rows": [],
  "validationIssues": [],
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "metrics": { "searchCalls": 0, "fetchCalls": 0, "browserCalls": 0, "agentRuns": 0, "agentSteps": 0 },
  "benchmarkTrace": {
    "sessionCount": 0,
    "insertCount": 0,
    "usage": {},
    "usageByKind": { "orchestrator": {}, "investigate": {} },
    "sessions": []
  }
}
```

Delete the `benchmarks/` folder to remove all benchmark tooling from the repo — no `backend/src` benchmark code is required.
