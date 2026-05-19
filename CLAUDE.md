# BigSet

Monorepo: `frontend/` (Next.js 16) + `backend/` (Fastify). Run with `make dev` (Docker).

Frontend on :3500, backend on :3501.

## Setup

1. Create a free Clerk account at https://clerk.com and create an application.
2. In the Clerk dashboard, go to **JWT Templates** and enable the **Convex** template.
3. Copy `frontend/.env.example` to `frontend/.env.local` and fill in your Clerk keys:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — from Clerk API Keys
   - `CLERK_SECRET_KEY` — from Clerk API Keys
   - `CLERK_JWT_ISSUER_DOMAIN` — your Frontend API URL (e.g. `https://your-app.clerk.accounts.dev`)
4. Run `make dev` — this starts all Docker services AND pushes Convex functions automatically.
5. Generate a Convex admin key (first run only): `docker compose exec convex ./generate_admin_key.sh` and add it as `CONVEX_SELF_HOSTED_ADMIN_KEY` in `frontend/.env.local`, then re-run `make dev`.

## Architecture

Auth is Clerk. Frontend uses `@clerk/nextjs` with `ClerkProvider` wrapping the app. Convex validates Clerk JWTs via `convex/auth.config.ts`. Protected routes enforced by Clerk proxy (`frontend/proxy.ts`). No self-hosted auth database.

Dataset storage uses Convex (self-hosted at :3210). Schema in `frontend/convex/schema.ts`, functions in `frontend/convex/datasets.ts` and `frontend/convex/datasetRows.ts`. Convex dashboard at :6791.

Frontend uses Convex React hooks (`useQuery`, `useMutation`) with `ConvexProviderWithClerk` for authenticated realtime queries. Use `useConvexAuth()` (not Clerk's `useAuth()`) to check auth state in components.

Backend is an agent runner — Fastify + `ConvexHttpClient`. It writes to Convex via HTTP mutations (`backend/src/convex.ts`). It does not handle auth.

Convex functions use `ctx.auth.getUserIdentity()` to get the authenticated user. The `ownerId` field on datasets stores `identity.subject` (Clerk user ID). Do not pass `ownerId` from the client.

## Convex Deploys

Convex is self-hosted — it does NOT hot-reload when you edit files in `frontend/convex/`. After changing any Convex function, schema, or auth config, you must run `make convex-push` to deploy the updated code to the running instance. `make dev` does this automatically on startup, but subsequent edits require a manual push.

In CI/prod, run `npx convex deploy` with `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` set as env vars.

This is an open-source (AGPL) project. Do not commit secrets, API keys, or internal docs.
