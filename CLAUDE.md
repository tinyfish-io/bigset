# BigSet

Monorepo: `frontend/` (Next.js 16) + `backend/` (Fastify). Run with `make dev` (Docker).

Frontend on :3500, backend on :3501. Auth requests proxy through Next.js rewrites (`/api/auth/*` → backend). Cookies stay same-origin — do not break this.

Auth is Better Auth (not Clerk). Self-hosted, no vendor dependencies. The backend owns auth, the frontend is a pure client.

Database is Postgres via Drizzle ORM. Schema lives in `backend/src/schema.ts`. Push changes with `drizzle-kit push`.

This is an open-source (AGPL) project. Do not commit secrets, API keys, or internal docs.
