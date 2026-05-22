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
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
  --system collection-self-heal='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/collection-self-healing-adapter.mjs'
```

Real collection benchmark runs require `OPENROUTER_API_KEY`,
`TINYFISH_API_KEY`, and `BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE` loaded in
the shell. The runner module must export `runCollectionPopulatePipeline(input)`
or a default runner that accepts `CollectionPopulatePipelineInput` and returns a
`PopulateRuntimeResult`.

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
- `BIGSET_BENCHMARK_REQUIRED_COLUMNS`
- `BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS`

`BIGSET_BENCHMARK_REQUIRED_COLUMNS` is the requested table shape.
`BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS` is the hard row identity minimum.
Rows still need at least one source URL and evidence quote.

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
