# Backend

Fastify + TypeScript + ESM (`"type": "module"` — use `.js` extensions in imports).

## HTTP API (Fastify)

Fastify serves the backend API on :3501. Protected routes use Clerk JWT verification via the `requireAuth` preHandler in `src/clerk-auth.ts`. The frontend passes a Bearer token (from `@clerk/nextjs` `getToken()`) on every request.

Routes:
- `GET /health` — public health check
- `POST /infer-schema` — protected. Accepts `{ prompt: string }`, returns a `DatasetSchema`. Calls `inferSchema()` from the pipeline.
- `POST /populate` — protected. Accepts a `DatasetContext` (datasetId, name, description, columns). Triggers the populate workflow which clears existing rows, then uses an AI agent to search the web and insert real data.

To add a new protected route, register it inside the scoped plugin in `src/index.ts` that has `requireAuth` as a preHandler. Use `req.auth.userId` for the authenticated user — never trust user-supplied IDs in the body.

## Schema Inference Pipeline

`src/pipeline/schema-inference.ts` — takes a natural language prompt and returns a structured `DatasetSchema` (Zod-validated, defined in `src/pipeline/types.ts`). Uses Claude Sonnet 4.6 via OpenRouter (`@openrouter/ai-sdk-provider` + Vercel AI SDK). Auto-retries once on validation failure by feeding the error back to the model.

The pipeline is a pure function (`inferSchema(prompt) → DatasetSchema`). It is called by both Fastify (for the HTTP API) and Mastra (for workflow orchestration).

## Mastra (Workflow Orchestration)

`src/mastra/` — wraps pipelines into Mastra workflows. Runs as a separate Docker service on :4111 with `mastra dev`, which provides a Studio UI for inspecting and testing workflows.

- `src/mastra/index.ts` — registers workflows with the `Mastra` instance (agents are built per-run, not registered as singletons)
- `src/mastra/workflows/infer-schema.ts` — `inferSchemaWorkflow`, a single-step workflow wrapping `inferSchema()`
- `src/mastra/workflows/populate.ts` — `populateWorkflow`, 3-step workflow: clear rows → build prompt → run populate agent

### Tri-agent architecture

The populate pipeline uses three layers of agents, each with a narrow scope:

1. **Populate Orchestrator** (`src/mastra/agents/populate.ts`) — `buildPopulateAgent(authorizedDatasetId, authContext, columns, targetRows)`. Searches the web only; has no write tools. Dispatches URLs to triage-extract agents via `extract_rows`, tracks progress via `list_rows`. Runs 5 parallel searches for the first batch, up to 20 for subsequent batches. Stops when `targetRows` complete rows are reached or 2 consecutive stagnant batches occur.

2. **Triage-Extract Agent** (`src/mastra/agents/triage-extract.ts`) — `buildTriageExtractAgent(columns, primaryKeyColumn, insertRowTool, updateRowByKeyTool, investigateEntityTool)`. Receives ONE URL, fetches it, classifies the page (extract_now / needs_browser_agent / needs_form_fill / low_value / blocked), extracts ALL matching entities, then dispatches `investigate_entity` for rows with missing columns. The triage step enables future routing to TinyFish browser agents or other specialized fetchers based on triage status. No `search_web` — fetch only.

3. **Investigate Agent** (`src/mastra/agents/investigate.ts`) — `buildInvestigateAgent(columns, primaryKeyColumn, updateRowByKeyTool)`. Researches ONE specific entity to fill its missing columns. Has `search_web` + `fetch_page` + `update_row_by_key`. Returns structured output (`INSERTED: false / SUMMARY / CLUES / REASON`).

### Tool factories

- `src/mastra/tools/investigate-tool.ts` — `buildExtractTool(authorizedDatasetId, authContext, columns, targetRows)` returns `{ extractRowsTool, listRowsTool }`. Both tools share a single in-memory `rowIndex` (Map of primary-key → `{rowId, confidence, cells}`) that serves as the canonical state for the run — no Convex round-trip needed for deduplication checks. `extract_rows` dispatches one URL to a fresh triage-extract agent (maxSteps: 40); `list_rows` returns a compact text summary of all rows for the orchestrator. Also builds `investigate_entity` internally, which spawns a fresh investigate agent (maxSteps: 20) and shares the same `rowIndex`.
- `src/mastra/tools/dataset-tools.ts` — `buildPopulateTools(authorizedDatasetId, authContext)` factory returning 5 Convex-backed tools: `insert_row`, `list_rows`, `get_row`, `update_row`, `delete_row`. Not used by the populate agent itself — used by other callers. The dataset id is captured by closure so the LLM cannot redirect writes to other datasets; `authContext` (Clerk userId + workflow run id) is captured for caller-attribution in security logs and the `CAPABILITY_VIOLATION` PostHog event. See the security note at the top of the file.
- `src/mastra/tools/web-tools.ts` — 2 TinyFish API tools: `search_web`, `fetch_page`

### Confidence and merge semantics

`update_row_by_key` uses per-field blank-aware merge rules, enforced atomically in the `datasetRows.mergeUpdate` Convex mutation:
- **Blank cells**: always filled with any non-empty incoming value, regardless of confidence.
- **Non-blank cells**: only overwritten when the new confidence is strictly higher than the row's existing confidence.

The authoritative check lives in Convex (not in the tool layer) because the in-memory `rowIndex` is stale during parallel agent runs. Two concurrent investigate agents reading the same cached confidence could both pass a client-side check, and the slower/weaker write could win. Moving the compare-and-merge into a single Convex transaction eliminates that race.

The populate workflow builds a fresh orchestrator per run via `buildPopulateAgent(...)` and calls `.generate(prompt, { maxSteps: 80 })`. Per-run construction is required by the capability-scoping security model (closure-bound dataset id); do not cache or share agents across runs.

All tools return structured error messages (not thrown exceptions) so the agent can self-correct.

Mastra uses `HOST` and `PORT` env vars for binding. In Docker, `HOST=0.0.0.0` is required.

## Convex

Writes to Convex via `ConvexHttpClient` in `src/convex.ts`. Import `{ convex, api, internal }` from `./convex.js` to call Convex mutations and queries. Uses `anyApi` from `convex/server` as an untyped proxy — this avoids cross-project imports from the frontend's generated code, which don't work in Docker containers. Admin key is set via `setAdminAuth()` for internal mutations.

## Environment

Required env vars (see `.env.example`):
- `CONVEX_URL` — Convex instance URL
- `CONVEX_SELF_HOSTED_ADMIN_KEY` — for system-level Convex writes (internal mutations)
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` — for JWT verification
- `OPENROUTER_API_KEY` — for AI model calls
- `TINYFISH_API_KEY` — for web search and fetch (populate agent). Get one at https://agent.tinyfish.ai/api-keys

In Docker, these are interpolated from the root `.env` file via `docker-compose.dev.yml`.
