# BigSet Backend

Fastify server that handles auth, database, and talks to TinyFish APIs.

## Running

```bash
# From the repo root:
cp .env.example .env
# Fill in the root .env file.
cd backend
npm install
npx drizzle-kit push
npm run dev
```

Starts on [localhost:3501](http://localhost:3501).

## Key Paths

- `src/index.ts` — Fastify server + route setup
- `src/auth.ts` — Better Auth config
- `src/schema.ts` — Drizzle table definitions
- `src/db.ts` — Database connection

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start with hot reload |
| `npm run build` | Compile TypeScript |
| `npm run db:push` | Push schema changes to Postgres |

Local backend scripts load the repo-root `.env` through `../scripts/with-root-env.mjs`.

## Self-Healing Commit Cap

`populate:self-heal --commit` and `POST /populate` use a configurable
per-dataset hourly safety throttle before writing rows. Override with
`POPULATE_COMMIT_ROW_LIMIT_PER_HOUR` or CLI
`--commit-row-limit-per-hour`.

Dry runs and benchmarks do not commit rows, so they do not consume this cap.
