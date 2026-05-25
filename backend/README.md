# BigSet Backend

Fastify server that handles auth, database, and talks to TinyFish APIs.

## Running

```bash
# From the repo root:
cp .env.example .env
# Fill in the root .env file.
cd backend
npm install
npm run dev
```

Starts on [localhost:3501](http://localhost:3501).

## Key Paths

- `src/index.ts` — Fastify server + route setup
- `src/clerk-auth.ts` — Clerk JWT verification
- `src/convex.ts` — Convex HTTP client
- `src/env.ts` — root env loader

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start with hot reload |
| `npm run build` | Compile TypeScript |

Local backend scripts load the repo-root `.env` through `../scripts/with-root-env.mjs`.
