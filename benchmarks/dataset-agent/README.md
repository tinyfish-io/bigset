# Dataset Agent Benchmark

This benchmark is the shared harness for comparing Edward's dataset agent and
Mengzhe's dataset agent on the same prompts.

It is intentionally standalone: no project dependencies, no secret reads, and no
assumption about which agent framework is under test. Each system just needs a
command that accepts a prompt and prints JSON.

## Run

In this script, `--system name=command` means:

- `name` is the label shown in the report, such as `mengzhe` or `edward`.
- `command` is whatever local command runs that agent once for one prompt.
- The benchmark calls that command once per prompt and reads JSON from stdout.

It is not a system manager. It is just a benchmark lane.

Recommended plug-in path:

```bash
cp benchmarks/dataset-agent/adapters/template-adapter.mjs \
  benchmarks/dataset-agent/adapters/local-mengzhe-adapter.mjs
```

Edit `local-mengzhe-adapter.mjs` so `runCurrentAgent()` calls the current agent
code. Then run:

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --system mengzhe='node benchmarks/dataset-agent/adapters/local-mengzhe-adapter.mjs'
```

For two agents:

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --system mengzhe='node benchmarks/dataset-agent/adapters/local-mengzhe-adapter.mjs' \
  --system edward='node benchmarks/dataset-agent/adapters/edward-ai-sdk-adapter.mjs'
```

Local adapter files are gitignored, so people can wire their own branch without
committing secrets, private paths, or messy prototype code.

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

Most adapters should read the env vars instead of using placeholders. Use
placeholders only when the existing agent already has a CLI that accepts args.

## Edward AI SDK Agent

This branch includes Edward's AI SDK dataset agent adapter:

```bash
DATASET_AGENT_RUNTIME=ai-sdk \
DATASET_AGENT_MODEL=openai/gpt-5.4 \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --system edward='node benchmarks/dataset-agent/adapters/edward-ai-sdk-adapter.mjs'
```

It uses the backend script:

```bash
npm --prefix backend run dataset-agent:benchmark
```

For local no-secret smoke tests, use deterministic mode:

```bash
DATASET_AGENT_RUNTIME=deterministic \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --system edward='node benchmarks/dataset-agent/adapters/edward-ai-sdk-adapter.mjs'
```

When using a fresh API key, start with a cheap canary subset:

```bash
DATASET_AGENT_RUNTIME=ai-sdk \
DATASET_AGENT_MODEL=openai/gpt-5.4 \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
  --system edward='node benchmarks/dataset-agent/adapters/edward-ai-sdk-adapter.mjs'
```

If the canary is blocked by auth, credits, quota, rate limits, or timeout, fix that
before running the full 16 prompts.

Real AI SDK runs require model auth plus `TINYFISH_API_KEY` loaded execution-only.
Do not commit local env files.

## How To Plug In An Existing Agent

Do not rewrite the benchmark. Write a thin adapter around the current agent.

The adapter has one job:

1. Read `BIGSET_BENCHMARK_PROMPT`.
2. Call the current dataset agent exactly once.
3. Convert that agent's output into the JSON contract below.
4. Print only that JSON object to stdout.
5. Send logs to stderr with `console.error(...)`.

If the existing agent is a JS/TS function, import it in the adapter:

```js
const prompt = process.env.BIGSET_BENCHMARK_PROMPT;
const agentResult = await runDatasetAgent({ prompt });
console.log(JSON.stringify(toBenchmarkPayload(agentResult)));
```

If the existing agent is a CLI, call it from the adapter:

```js
const child = spawn("npm", ["run", "agent:run", "--", prompt], {
  stdio: ["ignore", "pipe", "pipe"],
});
```

If the existing agent is a local HTTP server, call it from the adapter:

```js
const response = await fetch("http://localhost:3001/dataset-agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt }),
});
```

## Agent Handoff Prompt

Paste this to another coding agent when handing off:

```text
Your task is to plug the current dataset agent into the benchmark harness.

Do not change benchmarks/dataset-agent/run-benchmark.mjs.
Create benchmarks/dataset-agent/adapters/local-mengzhe-adapter.mjs from
benchmarks/dataset-agent/adapters/template-adapter.mjs.

The adapter must:
- read BIGSET_BENCHMARK_PROMPT
- run the current dataset/data-collection agent once for that prompt
- print one JSON object to stdout using the benchmark contract
- put logs on stderr only
- include rows, source URLs, evidence quotes, validation issues, usage tokens,
  and search/fetch/browser/agent metrics when available

Then run:
node benchmarks/dataset-agent/run-benchmark.mjs \
  --system mengzhe='node benchmarks/dataset-agent/adapters/local-mengzhe-adapter.mjs'

For quick validation, first run with --prompt-ids on a 2-3 prompt subset.
Commit only docs or reusable adapter templates. Do not commit local-* adapters,
env files, logs, reports, screenshots, transcripts, private links, or secrets.
```

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

- ok/failed/blocked status
- factual accuracy score
- failure category
- expected entity coverage
- official-domain accuracy
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
- prompt output satisfies the prompt-specific answer key in `run-benchmark.mjs`
- answerable prompts include rows, source URLs, evidence quotes, required cells,
  expected entities, and official domains
- underspecified prompts can pass by asking for missing inputs or explicitly
  abstaining instead of inventing facts

Auth, credit, quota, rate-limit, and timeout failures are marked `blocked`, not
`failed`, so benchmark quality is not polluted by infra noise.

Rescore existing artifacts without rerunning agents:

```bash
node benchmarks/dataset-agent/run-benchmark.mjs \
  --rescore-dir benchmark-results/<run-directory>
```

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
