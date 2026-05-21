# Backend

Fastify + TypeScript + ESM (`"type": "module"` — use `.js` extensions in imports).

## HTTP API (Fastify)

Fastify serves the backend API on :3501. Protected routes use Clerk JWT verification via the `requireAuth` preHandler in `src/clerk-auth.ts`. The frontend passes a Bearer token (from `@clerk/nextjs` `getToken()`) on every request.

Routes:
- `GET /health` — public health check
- `POST /infer-schema` — protected. Accepts `{ prompt: string }`, returns a `DatasetSchema`. Calls `inferSchema()` from the pipeline.

To add a new protected route, register it inside the scoped plugin in `src/index.ts` that has `requireAuth` as a preHandler. Use `req.auth.userId` for the authenticated user — never trust user-supplied IDs in the body.

## Schema Inference Pipeline

`src/pipeline/schema-inference.ts` — takes a natural language prompt and returns a structured `DatasetSchema` (Zod-validated, defined in `src/pipeline/types.ts`). Uses Claude Sonnet 4.6 via OpenRouter (`@openrouter/ai-sdk-provider` + Vercel AI SDK). Auto-retries once on validation failure by feeding the error back to the model.

The pipeline is a pure function (`inferSchema(prompt) → DatasetSchema`). It is called by both Fastify (for the HTTP API) and Mastra (for workflow orchestration).

## Mastra (Workflow Orchestration)

`src/mastra/` — wraps pipelines into Mastra workflows. Runs as a separate Docker service on :4111 with `mastra dev`, which provides a Studio UI for inspecting and testing workflows.

- `src/mastra/index.ts` — registers workflows with the `Mastra` instance
- `src/mastra/workflows/infer-schema.ts` — `inferSchemaWorkflow`, a single-step workflow wrapping `inferSchema()`

Mastra uses `HOST` and `PORT` env vars for binding. In Docker, `HOST=0.0.0.0` is required.

## Convex

Writes to Convex via `ConvexHttpClient` in `src/convex.ts`. Import `{ convex, api }` from `./convex.js` to call Convex mutations and queries. The `api` types are re-exported from the frontend's generated Convex code.

The `tsconfig.json` includes `../frontend/convex` so TypeScript can resolve the generated types.

## Environment

Required env vars (see `.env.example`):
- `CONVEX_URL` — Convex instance URL
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` — for JWT verification
- `OPENROUTER_API_KEY` — for AI model calls

In Docker, these are interpolated from the root `.env` file via `docker-compose.dev.yml`.
