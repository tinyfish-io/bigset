# Dataset Agent Benchmark

Shared harness for scoring one dataset agent command against the same prompt pack.

The runner is intentionally standalone. Each system is a command that reads the
benchmark env vars, runs one prompt, and prints one JSON object to stdout.

## Run Mastra Populate

The Mastra adapter calls `runPopulateRuntime`, a direct callable runtime around
the Mastra populate agent. It avoids the HTTP/auth route and uses an injected
in-memory row sink so benchmark runs do not clear or insert Convex rows.

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
  --system mastra='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs'
```

Real Mastra benchmark runs require `OPENROUTER_API_KEY` and `TINYFISH_API_KEY`
loaded execution-only. If either is missing, the adapter returns a blocked
benchmark result instead of touching app data.

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
