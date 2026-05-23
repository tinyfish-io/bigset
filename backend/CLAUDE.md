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

- `src/mastra/index.ts` — registers agents and workflows with the `Mastra` instance
- `src/mastra/workflows/infer-schema.ts` — `inferSchemaWorkflow`, a single-step workflow wrapping `inferSchema()`
- `src/mastra/workflows/populate.ts` — `populateWorkflow`, 3-step workflow: clear rows → build prompt → run populate agent
- `src/mastra/agents/populate.ts` — `populateAgent`, an AI agent (Claude Sonnet 4.6 via OpenRouter) with 7 tools for database CRUD and web access
- `src/mastra/tools/dataset-tools.ts` — 5 Convex-backed tools: `insert_row`, `list_rows`, `get_row`, `update_row`, `delete_row`
- `src/mastra/tools/web-tools.ts` — 2 TinyFish API tools: `search_web`, `fetch_page`

The populate agent uses `createStep(agent, { maxSteps: 80 })` to allow enough tool-call rounds for web research + row insertion.

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
