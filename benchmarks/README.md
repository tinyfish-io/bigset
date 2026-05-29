# BigSet Benchmarks

This directory contains the benchmark runner for the BigSet populate workflow. It exercises the **real** populate pipeline — same agent code, same Convex writes, same TinyFish API calls — so the metrics reflect actual agent performance rather than a simulation.

Every populate run (benchmark or real user session) automatically records its stats to the `runStats` Convex table. This means you can analyze cost and performance for both benchmark runs and live app usage from the same place.

---

## How metrics are collected

When a user clicks "Populate" in the app, or when the benchmark runner triggers a run, the workflow instruments every tool call automatically:

| Metric | What it counts |
|---|---|
| `searchCalls` | Calls to `search_web` (TinyFish search API) |
| `fetchCalls` | Calls to `fetch_page` (TinyFish fetch API) |
| `investigateCalls` | `run_subagent` dispatches from the orchestrator |
| `rowsInserted` | Rows successfully inserted into the dataset |
| `tokensInput` / `tokensOutput` | Total LLM tokens across all agents |
| `orchestratorTokens*` / `investigateTokens*` | Token breakdown per agent tier |
| `orchestratorSteps` / `investigateSteps` | Agent reasoning steps per tier |
| `investigateRuns` | How many investigate subagents completed |
| `durationMs` | Wall-clock time for the full populate run |

Each run also records `status` (`success` / `error`), any error message, and an `isBenchmark` flag so you can filter benchmark runs from real sessions.

> **Note:** The workflow includes an enumeration classification step that calls an LLM directly (not through an agent) to decide whether to use a scraper or search strategy. The tokens used by that step are **not** captured in the metrics above — they're a small fixed cost per run (~100–200 input tokens, ~5 output tokens) but worth knowing if you're doing precise cost accounting.

---

## Prerequisites

1. The dev stack must be running: `make dev`
2. Your root `.env` must have all required keys:
   - `OPENROUTER_API_KEY` — for LLM calls
   - `TINYFISH_API_KEY` — for web search and fetch
   - `CONVEX_URL` — Convex instance URL (default: `http://127.0.0.1:3210`)
   - `CONVEX_SELF_HOSTED_ADMIN_KEY` — to write benchmark datasets and read run records
3. `make convex-push` must have been run after the last schema change (or `make dev` does this automatically on startup)

---

## Running benchmarks

### Run all prompts

```bash
make benchmark
```

This runs all 4 prompts in `benchmarks/prompts.json` sequentially, prints a JSON summary to stdout, and cleans up the temporary Convex datasets afterward.

### Run a single prompt

```bash
make benchmark ARGS="--prompt yc-recent-batch-companies"
```

Available prompt IDs (defined in [`prompts.json`](./prompts.json)):

| ID | Dataset |
|---|---|
| `yc-recent-batch-companies` | YC W24/S24 companies |
| `b2b-saas-free-tier` | B2B SaaS tools with free tiers |
| `us-national-parks` | US National Parks |
| `ai-research-labs` | University AI research labs |

### Save results to disk

```bash
make benchmark ARGS="--out benchmark-results/"
```

Writes a timestamped JSON file to `benchmark-results/`. Useful for tracking performance across runs over time.

### Keep the datasets after a run (for inspection)

```bash
make benchmark ARGS="--no-cleanup"
```

The benchmark datasets will remain in your Convex instance under the owner `benchmark-runner`. You can inspect them in the Convex dashboard at http://localhost:6791.

### Run multiple prompts in parallel

```bash
make benchmark ARGS="--concurrency 2"
```

Runs up to 2 prompts concurrently. Note: parallel runs share TinyFish and OpenRouter rate limits — start with concurrency 1 for a clean baseline.

### Run directly with Node (no Make)

```bash
cd backend
npx tsx ../benchmarks/run.mts --prompt us-national-parks --out ../benchmark-results/
```

---

## Understanding the JSON output

The benchmark emits a JSON object to stdout when it finishes. Example:

```json
{
  "completedAt": "2025-01-15T10:30:00.000Z",
  "promptCount": 4,
  "successCount": 4,
  "failureCount": 0,
  "aggregate": {
    "rowsInserted": 62,
    "searchCalls": 47,
    "fetchCalls": 83,
    "investigateCalls": 68,
    "tokensInput": 1240000,
    "tokensOutput": 84000,
    "orchestratorSteps": 32,
    "investigateSteps": 412,
    "investigateRuns": 68,
    "durationMs": 1842000
  },
  "perRunAverages": {
    "rowsInserted": 15.5,
    "searchCalls": 11.8,
    "fetchCalls": 20.8,
    "investigateCalls": 17.0,
    "tokensTotal": 331000,
    "durationSeconds": 460.5
  },
  "runs": [
    {
      "promptId": "yc-recent-batch-companies",
      "workflowRunId": "benchmark-yc-recent-batch-companies-a1b2c3d4",
      "status": "success",
      "durationMs": 430000,
      "metrics": {
        "rowsInserted": 18,
        "searchCalls": 12,
        "fetchCalls": 22,
        "investigateCalls": 19,
        "tokensInput": 310000,
        "tokensOutput": 21000,
        "orchestratorTokensInput": 95000,
        "orchestratorTokensOutput": 4000,
        "orchestratorSteps": 8,
        "investigateTokensInput": 215000,
        "investigateTokensOutput": 17000,
        "investigateSteps": 98,
        "investigateRuns": 19
      }
    }
  ]
}
```

---

## Viewing run stats from actual app sessions

Every populate run triggered by a real user through the app UI is also recorded in `runStats`. You can query it directly via the Convex dashboard or CLI.

### Convex dashboard

Open http://localhost:6791 → select your Convex instance → go to **Data** → **runStats**.

Each row corresponds to one populate run. The `isBenchmark` field is `true` for benchmark runs and absent/`undefined` for real user sessions.

### Convex CLI queries

All queries below use the internal query functions added alongside the schema. Run them with `npx convex run` from the `frontend/` directory (or via the dashboard's **Functions** tab).

**List all runs for a specific dataset:**
```bash
cd frontend
node ../scripts/with-root-env.mjs npx convex run runStats:listByDataset \
  --url http://127.0.0.1:3210 \
  --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY" \
  '{"datasetId": "<your-dataset-id>"}'
```

**List all runs for a specific user:**
```bash
cd frontend
node ../scripts/with-root-env.mjs npx convex run runStats:listByUser \
  --url http://127.0.0.1:3210 \
  --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY" \
  '{"userId": "<clerk-user-id>"}'
```

**Fetch a single run by workflow run ID:**
```bash
cd frontend
node ../scripts/with-root-env.mjs npx convex run runStats:getByWorkflowRunId \
  --url http://127.0.0.1:3210 \
  --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY" \
  '{"workflowRunId": "<run-id>"}'
```

The `workflowRunId` appears in the backend logs when a populate starts:
```
[populate-agent] populate-agent start
```
and also in the HTTP response from `POST /populate` as the `runId` field.

### Exporting all benchmark runs to JSON

To export all benchmark runs for offline analysis:

```bash
cd frontend
node ../scripts/with-root-env.mjs npx convex run runStats:listByUser \
  --url http://127.0.0.1:3210 \
  --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY" \
  '{"userId": "benchmark-runner"}' | jq '.' > benchmark-history.json
```

---

## Adding custom prompts

Edit [`prompts.json`](./prompts.json) to add your own benchmark prompts. Each entry needs:

```json
{
  "id": "my-prompt-id",
  "datasetName": "Human-readable dataset name",
  "description": "What the dataset is about — shown to the agent",
  "columns": [
    { "name": "entity_name", "type": "text", "description": "The entity name", "isPrimaryKey": true },
    { "name": "other_field", "type": "text", "description": "What this field is" }
  ]
}
```

Column types: `text`, `number`, `boolean`, `url`, `date`.

Mark at least one column as `"isPrimaryKey": true` — the orchestrator uses this to tell subagents which field is the unique identifier, and the workflow uses it to reject duplicate rows automatically.

Then run:
```bash
make benchmark ARGS="--prompt my-prompt-id"
```

---

## Cost estimation

Rough estimates based on DeepSeek V4 Pro pricing (as of writing):

| Per run (20 rows target) | Approximate cost |
|---|---|
| Input tokens (~300k) | ~$0.84 |
| Output tokens (~20k) | ~$0.20 |
| TinyFish search (~12 calls) | ~$0.06 |
| TinyFish fetch (~20 calls) | ~$0.10 |
| **Total per run** | **~$1.20** |

These numbers come from the `tokensInput` / `tokensOutput` fields in `runStats`. Actual costs vary by dataset complexity and row count achieved.
