# Dataset Builder Agent Harness

## MVP Decision

Start with a backend-owned planning harness before table creation gets clever.
The first shippable slice is:

1. Turn a natural-language dataset request into a fixed schema.
2. Ask missing-input questions before browser/form automation when possible.
3. Prefer TinyFish Search + Fetch first.
4. Escalate only hard pages or form flows to TinyFish Agent/browser automation.
5. Validate cells against schema and source URL requirements.
6. Replace values for the same identity row on refresh instead of appending duplicates.

History, user trust flags, public dataset resale, column editing, and Convex sync stay future scope.

## Current Scaffold

- `backend/src/dataset-builder/types.ts` defines dataset schema, plan, clarifying questions, harness stages, and run artifacts.
- `backend/src/dataset-builder/planner.ts` creates a deterministic draft plan from a user request.
- `backend/src/dataset-builder/openrouter.ts` optionally refines the draft through OpenRouter chat completions.
- `backend/src/dataset-builder/agent-harness.ts` converts a plan into TinyFish agent goals and output schemas.
- `backend/src/dataset-builder/tinyfish-cli.ts` is a local prototype adapter for TinyFish Search, Fetch, and Agent CLI runs.
- `backend/src/routes/dataset-builder.ts` exposes `POST /api/dataset-builder/plan` behind Better Auth.
- `backend/src/schema.ts` now has `dataset` and `dataset_run` metadata tables for plan/run storage.

## Prototype Command

From `backend/`:

```bash
npm run builder:plan -- "restaurants in Menlo Park that serve Coca-Cola"
```

Use OpenRouter when a key is loaded:

```bash
npm run builder:plan -- "car insurance quotes for a 2021 Honda Civic in Menlo Park" --use-openrouter
```

The command prints the plan, generated TinyFish agent goal, and output schema. It never prints API keys.

## API Contract

`POST /api/dataset-builder/plan`

```json
{
  "userRequest": "latest blog posts from my competitors",
  "updateCadence": "daily",
  "planningMode": "openrouter",
  "providedInputs": {
    "competitors": "exa.ai, perplexity.ai"
  },
  "preferredColumns": ["latest post URL"]
}
```

Response includes:

- `planId`
- `plan`
- `tinyFishAgentGoal`
- `tinyFishAgentOutputSchema`

## Next Tickets

1. Persist generated plans in `dataset`.
2. Add `POST /api/datasets/:id/runs` to run the harness and write `dataset_run` artifacts.
3. Decide if TinyFish execution should use direct HTTP APIs or CLI only for local experiments.
4. Add a DB-backed queue/lease before cron refresh jobs.
5. Add frontend create-dataset flow once Divya's table UI is ready.
