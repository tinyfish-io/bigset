# Backend

Fastify + TypeScript + ESM (`"type": "module"` — use `.js` extensions in imports).

Better Auth has no native Fastify plugin. The catch-all in `src/index.ts` bridges Fastify requests to Better Auth's Web Request handler via `fromNodeHeaders`. Don't refactor this into middleware — it's intentionally explicit.

Schema in `src/schema.ts` must match Better Auth's expected tables (user, session, account, verification). Check Better Auth docs before modifying.

Drizzle ORM with `pg` driver. Connection string from `DATABASE_URL` env var.
