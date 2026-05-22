# Data Collection Agent Migration Plan

This plan keeps the app, benchmark harness, and self-healing layer aligned while
the collection pipeline is migrated into BigSet.

## Current State

- PR #31-#37 form the current Mastra populate/self-healing stack. They are
  intentionally stacked and should not be merged out of order.
- PR #37 adds `make verify-self-healing`, which is the cheap local gate before
  touching live data or spending OpenRouter/TinyFish credits.
- PR #38 adds this migration plan and keeps the target boundaries explicit.
- PR #39 adds `CollectionPopulateRecipeRuntime`, an adapter boundary that can
  run a collection pipeline through the same `PopulateRecipeRuntime` interface
  as Mastra.
- PR #40 adds `POPULATE_AGENT_RUNTIME=collection` selection through the real
  HTTP and CLI entrypoints. PR #42 extends that socket so app/CLI runs can load
  a runner module from `POPULATE_COLLECTION_RUNNER_MODULE`.
- PR #41 adds a `collection-self-heal` benchmark lane that wraps the collection
  runtime inside `SelfHealingPopulateRecipeService`. This is the benchmark
  socket Meteor can use once the real collection runner is available.
- PR #43 ports the real vendored collection pipeline behind
  `runCollectionPopulatePipeline(input)`, so the collection benchmark lane now
  runs the BigSet-wrapped collection runner instead of a fake injected runner.
- PR #44 keeps TinyFish Agent/browser work opt-in and bounded by a per-run poll
  timeout. This preserves cheap cron/benchmark reruns as the default path.
- PR #45 improves collection source targeting for official-source prompts
  without injecting answer-key URLs at runtime.
- PR #46 surfaces no-Agent browser/form/detail follow-up as a safe capability
  diagnostic instead of hiding it as generic bad data or infra failure.
- PR #47-#52 document and improve collection benchmark evidence, source
  coherence, official-source support, and URL-like source evidence. PR #52 fixes
  the `official_website` / `company_website` / `product_url` scoring class.
- `feat/data-collection-agent-v14` is no longer the branch to build on directly.
  It was the source of the collection pipeline port. New work should branch on
  top of the current draft stack, not edit Meteor's branch or the dirty main
  checkout.

## Target Shape

The app should have one stable populate boundary:

```text
POST /populate or cron CLI
  -> load DatasetContext
  -> self-healing populate service
  -> selected PopulateRecipeRuntime
  -> source-backed rows + evidence
  -> validation gate
  -> optional Convex atomic row replace
```

The collection pipeline should become one implementation of
`PopulateRecipeRuntime`. It should not own app auth, row deletion, Convex writes,
or cron scheduling. Those stay in BigSet.

The critical contract is `runRecipe({ recipe, context })`. A collection runtime
adapter must thread `recipe.runtimeInstructions` into the collection prompt/spec,
because those instructions are how a repaired recipe changes future runtime
behavior. A runtime that ignores `recipe.runtimeInstructions` is not actually
self-healing.

## What Self-Healing Does Now

The current layer:

- stores active recipes and run records in a filesystem recipe store on the
  durable app/commit path
- persists each run's artifacts on the run record, including a structured
  `process-trace` artifact when the runtime exposes one
- reruns the active recipe when one exists
- generates an initial recipe when no active recipe exists
- repairs a failed active recipe through `DefaultPopulateRecipeAuthor`
- validates rows for requested-column completeness, source URL coverage,
  evidence quote coverage, and expected-entity coverage when the prompt names
  explicit entities
- promotes a repaired recipe only if it is valid and does not score below the
  active recipe baseline
- commits rows only after a successful tick, using one Convex atomic replace
- supports a CLI path for cron/live smoke via `populate:self-heal --dataset-id`

Dry-run and benchmark paths intentionally use in-memory stores so they do not
pollute durable recipe history.

The current layer now can:

- run an injected collection runner through the same self-healing runtime
  boundary and benchmark harness as Mastra
- run the real vendored collection pipeline through that same boundary
- preserve `recipe.runtimeInstructions`, required columns, and benchmark
  metadata through the collection runner
- expose structured trace data for both Mastra and collection runs:
  `runtime`, `searchQueries`, `fetchedUrls`, `sourceArtifacts`,
  `selectedRowSource`, `notes`, and ordered `steps`
- expose a `playwright-candidate-readiness` artifact that explains whether the
  trace is grounded enough to compile a future Playwright script
- represent browser actions in the trace contract when a future Agent/canary
  records URL transitions, selectors, target text, or redacted input
  descriptions
- emit a capability diagnostic when no-Agent mode sees pages that need browser,
  form, or detail-page follow-up

The current layer does not yet:

- generate Playwright scripts as a durable production recipe
- emit `playwright-candidate-script`; that artifact kind is reserved for the
  future compiler and is not produced yet
- run cron from compiled Playwright scripts
- repair or promote Playwright scripts; repair still changes durable runtime
  instructions only
- compile search/fetch-only traces into Playwright; traces must include
  actionable browser steps before the script compiler is allowed to emit a
  candidate
- run a green live Convex canary in this local environment
- prove Agent-enabled collection quality on a full real benchmark
- prove the collection runtime should replace Mastra as the default app runtime

## Migration Sequence

1. Branch from the top of the self-healing stack.
   - For new collection-runner or benchmark work, base on
     `codex/collection-capability-diagnostics` unless that PR has been
     superseded.
   - Do not edit `main`, the dirty local checkout, or
     `feat/data-collection-agent-v14` directly.

2. Fix the collection branch as a clean build source.
   - Status: done in PR #43 for the BigSet-wrapped collection runner path.
   - Keep vendored code isolated until the adapter is green.
   - Preserve the current backend Convex boundary: do not reintroduce imports
     from `frontend/convex/_generated` into backend compile. Use the existing
     `anyApi`/HTTP-client boundary instead.
   - Exclude non-essential vendored artifacts from the PR scope until the
     runtime adapter needs them.
   - Gate: `npm --prefix backend test` and `npm --prefix backend run build`.

3. Add a collection runtime adapter.
   - Status: done in PR #39.
   - Implement the existing `PopulateRecipeRuntime` interface.
   - Input: BigSet `DatasetContext`.
   - Transform `recipe.runtimeInstructions` into the collection pipeline
     prompt/spec alongside the dataset description and columns.
   - Propagate `requiredColumns`, prompt id, prompt quality, persona, and
     benchmark stress metadata into the collection pipeline's benchmark/spec
     generation path when those fields are available.
   - Output: rows, source URLs, evidence quotes, usage, metrics, and debug
     captured sources.
   - No direct Convex writes inside the adapter.
   - Gate: a unit test proving a repaired recipe's runtime instructions reach
     the downstream collection prompt/spec and can change observable runtime
     behavior.

4. Add runtime selection through the real entrypoints.
   - Status: done in PR #40 for injected collection runners.
   - Add a runtime factory for the self-healing runner.
   - Add an env switch such as `POPULATE_AGENT_RUNTIME=collection`.
   - Wire both `POST /populate` and `populate:self-heal --dataset-id` through
     that same factory.
   - Gate: one HTTP-route test, one CLI test, and one dry-run smoke proving both
     entrypoints use the selected runtime.

5. Add a self-healing-wrapped benchmark adapter for the collection runtime.
   - Status: done in PR #41 for injected collection runners.
   - Reuse `benchmarks/dataset-agent/run-benchmark.mjs`.
   - Exercise `SelfHealingPopulateRecipeService` with the collection runtime
     inside it, not the direct collection pipeline alone.
   - Compare this lane against the existing Mastra-inside-self-healing lane.
   - Return blocked results when required API keys are missing.
   - Gate: no-key smoke must block with zero tokens, zero tool calls, and zero
     estimated spend.

6. Run quality gates in increasing cost order.
   - `make verify-self-healing`
   - 2-prompt real benchmark
   - 1-prompt Agent-enabled capability canary for prompts that need browser or
     detail follow-up
   - browser-step trace canary that records URL transitions, selectors/targets,
     and redacted form-input descriptions before any Playwright compiler is
     enabled
   - full benchmark only after the 2-prompt run is not obviously broken
   - live `--dataset-id` dry-run only after Convex/env prerequisites are ready
   - `--commit` only on a throwaway dataset first

7. Keep runtime selection explicit.
   - Keep current Mastra runtime as default until collection runtime benchmark
     evidence is better.
   - Do not claim collection runtime quality from a direct, non-self-healing
     benchmark lane.

8. Decide merge order from evidence, not preference.
   - If collection runtime is better, stack it after #37 and merge the stack
     from bottom to top.
   - If collection runtime is not better, keep it as a draft branch and use
     benchmark artifacts to decide what to fix next.

## Acceptance Gates

Before any merge:

- no real `.env` files or private notes in the diff
- `git diff --name-status main...HEAD` reviewed for public PR hygiene
- `make verify-self-healing` passes
- `npm --prefix backend test` passes
- `npm --prefix backend run build` passes
- adapter test proves `recipe.runtimeInstructions` reaches the collection
  pipeline prompt/spec
- adapter or runner tests prove benchmark metadata and `requiredColumns` reach
  the collection pipeline's spec generation path
- HTTP-route and CLI tests prove `POPULATE_AGENT_RUNTIME=collection` reaches
  the selected runtime through real app entrypoints
- benchmark no-key smoke proves blocked with zero spend
- benchmark evidence comes from the collection runtime wrapped inside the
  self-healing service, not the direct collection pipeline alone
- real benchmark artifacts are linked in the PR when runtime quality is claimed
- capability diagnostics are treated as warnings for healthy rows and as honest
  benchmark failure messages when no-Agent mode cannot complete browser/form
  follow-up
- live dataset commit is tested only on a throwaway dataset
- backend build does not depend on `frontend/convex/_generated`

## Meteor Handoff Shape

Meteor does not need to rebuild the self-healing wrapper. The socket is now:

```text
runCollectionPopulatePipeline(CollectionPopulatePipelineInput)
  -> Promise<PopulateRuntimeResult>
```

`CollectionPopulatePipelineInput.recipeInstructions` is the self-healing signal.
`requiredColumns` and benchmark metadata are the scoring signal. If the
collection runner ignores `recipeInstructions`, repaired recipes cannot change
future behavior. If it ignores `requiredColumns` or benchmark metadata, the
benchmark can stop measuring the same task.

The real benchmark command after a runner module exists is:

```bash
COLLECTION_AGENT_PIPELINE_MODULE=./backend/BigSet_Data_Collection_Agent/src/orchestrator/pipeline.ts \
BIGSET_COLLECTION_BENCHMARK_RUNNER_MODULE=./backend/src/pipeline/collection-agent-runner.ts \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
  --system collection-self-heal='node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/collection-self-healing-adapter.mjs'
```

For prompts that likely require browser/detail follow-up, run the same lane with
Agent explicitly enabled:

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

No-Agent `mcp-docs-pages` evidence from PR #46:

- artifact: `benchmark-results/collection-capability-diagnostics-mcp-20260523-001`
- result: 3 rows, 6 evidence quotes, cost about `$0.007287`
- status: failed with
`Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up...`.
That is not a pass, but it is useful: it tells us the next benchmark should
turn Agent on and measure whether browser/detail follow-up fixes the source
evidence miss.

Agent-enabled `mcp-docs-pages` evidence from the stack-handoff branch:

- artifact: `benchmark-results/collection-agent-canary-mcp-20260523-001`
- result: 3 rows, 12 evidence quotes, 10 source URLs, 3 Agent runs
- cost: about `$0.053552`
- status: failed, not blocked
- score: factual accuracy `0.933`, entity coverage `1.0`, claim support `1.0`,
  domain accuracy `0.667`
- conclusion: Agent/browser follow-up runs successfully and improves claim
  support, but source/domain evidence still misses. The next code target is
  source coherence: keep each row's docs URL/evidence/source URLs aligned with
  that entity's official docs domain instead of merging discovery/blog/course
  evidence across vendors.

## Next Engineering Move

Create a fresh branch from `codex/collection-capability-diagnostics` and fix
source coherence before running the full benchmark:

1. Keep `COLLECTION_AGENT_ENABLE_AGENT=false` as the default.
2. Add focused tests around record merge/source selection so a row does not gain
   evidence for a populated field from another record unless the incoming row
   value supports the existing value.
3. Tighten docs/official-source selection so docs prompts prefer docs/developers
   pages over blogs, news, courses, directories, or third-party discovery pages.
4. Re-run the Agent-enabled `mcp-docs-pages` canary.
5. If domain accuracy reaches `1.0`, run the 4-prompt focused benchmark from
   PR #45.
6. Run the full prompt pack only after the focused benchmark is not obviously
   broken.

When testing the real app or CLI path, set:

```bash
POPULATE_AGENT_RUNTIME=collection
POPULATE_COLLECTION_RUNNER_MODULE=./backend/src/pipeline/collection-agent-runner.ts
COLLECTION_AGENT_PIPELINE_MODULE=./backend/BigSet_Data_Collection_Agent/src/orchestrator/pipeline.ts
```

The BigSet runner keeps TinyFish Agent/browser calls disabled unless
`COLLECTION_AGENT_ENABLE_AGENT=true`. This makes cron and benchmark reruns cheap
and repeatable first. Agent-enabled runs should also set
`COLLECTION_AGENT_POLL_TIMEOUT_MS` or `AGENT_POLL_TIMEOUT_MS` so a browser run
cannot outlive the benchmark/job budget.

Do not switch the default runtime from Mastra to collection until the
self-healing-wrapped collection benchmark has better evidence than the current
Mastra lane.
