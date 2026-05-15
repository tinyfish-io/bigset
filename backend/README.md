# BigSet Backend

Fastify server that handles auth, database, and talks to TinyFish APIs.

## Running

```bash
cp .env.example .env
# Set BETTER_AUTH_SECRET (openssl rand -base64 32)
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
