# Backend

Fastify + TypeScript + ESM (`"type": "module"` — use `.js` extensions in imports).

The backend is an agent runner. It does not handle auth — that is Clerk's job on the frontend.

Writes to Convex via `ConvexHttpClient` in `src/convex.ts`. Import `{ convex, api }` from `./convex.js` to call Convex mutations and queries. The `api` types are re-exported from the frontend's generated Convex code.

The `tsconfig.json` includes `../frontend/convex` so TypeScript can resolve the generated types.
