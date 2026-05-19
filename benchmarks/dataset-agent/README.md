# Dataset Agent Benchmark

This benchmark is the shared harness for comparing Edward's dataset agent and
Mengzhe's dataset agent on the same prompts.

It is intentionally standalone: no project dependencies, no secret reads, and no
assumption about which agent framework is under test. Each system just needs a
command that accepts a prompt and prints JSON.

## Run

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --system mengzhe='npm run benchmark -- {{promptJson}}' \
  --system edward='node ./path/to/edward-agent.js --prompt {{promptJson}}'
```

Useful placeholders:

- `{{promptJson}}`: shell-escaped JSON string for the prompt.
- `{{prompt}}`: shell-escaped raw prompt text.
- `{{promptId}}`: shell-escaped prompt id.
- `{{requiredColumnsJson}}`: shell-escaped JSON array of required columns.

The runner also sets env vars for each prompt:

- `BIGSET_BENCHMARK_PROMPT`
- `BIGSET_BENCHMARK_PROMPT_ID`
- `BIGSET_BENCHMARK_PROMPT_QUALITY`
- `BIGSET_BENCHMARK_REQUIRED_COLUMNS`

## Agent Output Contract

The command should print a JSON object to stdout. Preferred shape:

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
          "quote": "Example"
        }
      ],
      "needsReview": false
    }
  ],
  "validationIssues": [],
  "usage": {
    "promptTokens": 1234,
    "completionTokens": 567,
    "totalTokens": 1801
  },
  "metrics": {
    "searchCalls": 3,
    "fetchCalls": 4,
    "browserCalls": 0,
    "agentRuns": 1,
    "agentSteps": 12
  }
}
```

The runner is forgiving and also understands common variants like `data`,
`records`, `result`, `source_url`, `sources`, `inputTokens`, `outputTokens`,
`searchCallCount`, and `agentStepCount`.

## Metrics

The report includes:

- pass/fail
- wall-clock latency
- row count
- required-cell completeness
- missing required cells
- source URL count
- evidence quote count
- duplicate identity count
- needs-review count
- validation issue count
- search/fetch/browser/agent call counts
- agent step count
- input/output/total tokens
- estimated model cost
- estimated TinyFish Agent step cost
- estimated total cost

Default pass gate:

- command exits `0`
- stdout contains parseable JSON
- at least one row
- at least one source URL
- at least one evidence quote
- required-cell completeness is at least `0.75`

Cost defaults:

- input tokens: `$0.05` per 1M
- output tokens: `$0.50` per 1M
- TinyFish Agent step: `$0.015`

Override:

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --input-usd-per-1m 0.05 \
  --output-usd-per-1m 0.50 \
  --tinyfish-agent-step-usd 0.015 \
  --min-required-completeness 0.75 \
  --system mengzhe='npm run benchmark -- {{promptJson}}'
```

## Outputs

Default output path:

```text
benchmark-results/<timestamp>/
```

Files:

- `summary.json`: machine-readable aggregate and per-prompt results.
- `benchmark-report.md`: human-readable report for Discord/meeting review.
- per-system/per-prompt `stdout.txt`, `stderr.txt`, and `parsed-output.json`.

## Prompt Mix

`prompts.json` has 16 realistic prompts:

- 4 good prompts
- 6 average prompts
- 6 bad prompts

The point is not to make the agent look good. The point is to catch where it
breaks under prompts real people would actually type.
