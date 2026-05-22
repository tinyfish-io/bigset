# Dataset Agent Benchmark

Shared harness for scoring one dataset agent command against the same prompt pack.

The runner is intentionally standalone. Each system is a command that reads the
benchmark env vars, runs one prompt, and prints one JSON object to stdout.

## Run Mastra Populate

The Mastra adapter calls the self-healing populate service around
`runPopulateRuntime`. It avoids the HTTP/auth route, uses an isolated in-memory
recipe store per prompt run, and never clears or inserts Convex rows.

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
  --system mastra='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs'
```

Real Mastra benchmark runs require `OPENROUTER_API_KEY` and `TINYFISH_API_KEY`
loaded execution-only. If either is missing, the adapter returns a blocked
benchmark result instead of touching app data.

## Run Collection Inside Self-Healing

The collection adapter uses the same benchmark runner, but wraps
`CollectionPopulateRecipeRuntime` inside `SelfHealingPopulateRecipeService`.
That means collection results are scored after the same recipe generation,
repair, validation, and promotion path as the app runtime.

```bash
COLLECTION_AGENT_PIPELINE_MODULE=./backend/BigSet_Data_Collection_Agent/src/orchestrator/pipeline.ts \
BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE=./backend/src/pipeline/collection-agent-runner.ts \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
  --system collection-self-heal='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/collection-self-healing-adapter.mjs'
```

Real collection benchmark runs require `OPENROUTER_API_KEY`,
`TINYFISH_API_KEY`, `BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE`, and
`COLLECTION_AGENT_PIPELINE_MODULE` loaded in the shell. The benchmark runner
module must export `runCollectionPopulatePipeline(input)` or a default runner
that accepts `CollectionPopulatePipelineInput` and returns a
`PopulateRuntimeResult`. The pipeline module must export `runPipeline(options)`.
The BigSet runner keeps TinyFish Agent/browser calls off by default so the
benchmark stays cheap and bounded. Set `COLLECTION_AGENT_ENABLE_AGENT=true` to
opt in; Agent polling is capped by `AGENT_POLL_TIMEOUT_MS`, or by
`COLLECTION_AGENT_POLL_TIMEOUT_MS` when the generic timeout is unset.

When Agent is off and triage finds browser/form/detail-page follow-up, the
collection runner emits a non-fatal capability diagnostic. Healthy rows can
still pass self-healing validation with this diagnostic as a warning. Benchmark
failures show the same diagnostic as the failure message so the result says
"turn Agent on for this prompt" instead of pretending the run hit auth,
credits, or generic zero-row failure.

Use this canary when checking whether Agent/browser follow-up fixes the current
source-evidence misses:

```bash
COLLECTION_AGENT_ENABLE_AGENT=true \
COLLECTION_AGENT_POLL_TIMEOUT_MS=480000 \
COLLECTION_AGENT_PIPELINE_MODULE=./backend/BigSet_Data_Collection_Agent/src/orchestrator/pipeline.ts \
BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE=./backend/src/pipeline/collection-agent-runner.ts \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids mcp-docs-pages \
  --timeout-ms 900000 \
  --system collection-self-heal='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/collection-self-healing-adapter.mjs'
```

Latest `mcp-docs-pages` Agent-enabled canary evidence:

- artifact: `benchmark-results/collection-agent-canary-mcp-20260523-001`
- status: failed, not blocked
- rows/evidence: 3 rows, 12 evidence quotes, 10 source URLs
- cost: about `$0.053552`
- signal: Agent runs complete and claim support reaches `1.0`, but domain
  accuracy stays `0.667`; next fix is source/domain coherence, not more Agent
  plumbing.

App and CLI collection-runtime runs use the same runner shape, but load it from
`POPULATE_COLLECTION_RUNNER_MODULE` when `POPULATE_AGENT_RUNTIME=collection`.

Self-healing run records now include a `process-trace` artifact when a runtime
exposes trace data and a `playwright-candidate-readiness` artifact that says
whether the trace is grounded enough for a future Playwright compiler. Search
and fetch URLs alone are not enough. The readiness gate expects real browser
actions such as URL transitions, selectors, target text, or redacted input
descriptions before any `playwright-candidate-script` can be emitted.

## Verify Self-Healing Stack

Use this before asking someone else to migrate a new collection agent into the
app path:

```bash
make verify-self-healing
```

That command runs backend tests, backend build, adapter syntax checks, and
Mastra + collection no-key benchmark smokes that must produce clean `blocked`
results without spending OpenRouter or TinyFish credits.

Live checks are explicit:

```bash
bash scripts/verify-self-healing-stack.sh --real-benchmark
bash scripts/verify-self-healing-stack.sh --convex-push --dataset-id <dataset-id>
bash scripts/verify-self-healing-stack.sh --convex-push --dataset-id <dataset-id> --commit
```

The live benchmark and dataset smoke expect required env vars to already be
exported in the shell. They print only missing key names and never print secret
values. The `--convex-push` mode still uses the existing `make convex-push`
target, which requires `frontend/.env.local`.

## Benchmark Env

For each prompt the runner sets:

- `BIGSET_BENCHMARK_PROMPT`
- `BIGSET_BENCHMARK_PROMPT_ID`
- `BIGSET_BENCHMARK_PROMPT_QUALITY`
- `BIGSET_BENCHMARK_PERSONA`
- `BIGSET_BENCHMARK_EXPECTED_STRESS`
- `BIGSET_BENCHMARK_REQUIRED_COLUMNS`
- `BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS`

`BIGSET_BENCHMARK_REQUIRED_COLUMNS` is the requested table shape.
`BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS` is the hard row identity minimum.
Rows still need at least one source URL and evidence quote. Collection benchmark
runners receive prompt id, quality, persona, expected stress, and required
columns through `CollectionPopulatePipelineInput` so they can build the same
benchmark/spec context that the direct collection lane expects.

## Agent Output Contract

The command must print JSON:

```json
{
  "rows": [
    {
      "cells": {
        "entity_name": "Example",
        "source_url": "https://example.com"
      },
      "sourceUrls": ["https://example.com"],
      "evidence": [
        {
          "columnName": "entity_name",
          "sourceUrl": "https://example.com",
          "quote": "Example source quote"
        }
      ],
      "needsReview": false
    }
  ],
  "validationIssues": [],
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  },
  "metrics": {
    "searchCalls": 0,
    "fetchCalls": 0,
    "browserCalls": 0,
    "agentRuns": 1,
    "agentSteps": 0
  }
}
```

Logs must go to stderr.
