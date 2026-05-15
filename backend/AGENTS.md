# Backend — Agent Guidelines

ESM project — all local imports must use `.js` extension (e.g., `./auth.js`, not `./auth`).

Better Auth bridge in `src/index.ts` converts Fastify req/reply ↔ Web Request/Response. This is the only way Better Auth works with Fastify. Don't try to simplify it.

Do not add auth logic to the frontend. All auth lives here.
