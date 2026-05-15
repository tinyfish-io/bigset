# BigSet — Agent Guidelines

## Architecture

- **Frontend** (`frontend/`): Next.js 16, React 19, Tailwind 4. Pure UI — no server-side auth logic.
- **Backend** (`backend/`): Fastify, TypeScript, ESM. Owns auth, database, and will own TinyFish API calls + cron jobs.
- Auth requests from the browser hit `/api/auth/*` on the frontend, which proxies them to the backend via Next.js rewrites. This is intentional — do not add auth API routes to the frontend.

## What not to do

- Do not add Clerk, Auth0, or any third-party auth service. We use Better Auth (self-hosted).
- Do not add API routes to the frontend. All API logic belongs in the backend.
- Do not hardcode ports. Read from env vars (`PORT`, `CLIENT_ORIGIN`, `BETTER_AUTH_URL`).
- Do not commit `.env` files or secrets.

## Dev setup

`make dev` starts everything via Docker (Postgres, backend, frontend). That's the only supported dev workflow.
