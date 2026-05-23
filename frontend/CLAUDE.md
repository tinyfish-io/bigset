# Frontend

Next.js 16, React 19, Tailwind 4. Pure UI — no API routes, no server-side auth logic.

Auth uses `@clerk/nextjs`. `ClerkProvider` wraps the app in `layout.tsx`, `ConvexProviderWithClerk` bridges Clerk tokens to Convex in `convex-provider.tsx`. Protected routes enforced by `proxy.ts` (Clerk middleware). Sign-in/sign-up pages at `/sign-in` and `/sign-up` use Clerk's built-in components.

Use `useConvexAuth()` from `convex/react` (not Clerk's `useAuth()`) to check auth state in components. Use `useUser()` from `@clerk/nextjs` for user info (email, name). Use `useClerk()` for sign-out.

## Backend API Client

`lib/backend.ts` — typed fetch wrapper for calling the Fastify backend. Uses `useAuth().getToken()` from `@clerk/nextjs` to get a Bearer token. The backend URL comes from `NEXT_PUBLIC_BACKEND_URL` (defaults to `http://localhost:3501`).

Currently exposes `inferSchema(prompt, token)` which calls `POST /infer-schema` and returns an `InferredSchema`. The frontend maps backend types to UI types (e.g. `string` → `text`, `display_name` → column name) in the dataset wizard (`app/dataset/new/page.tsx`).

## Convex

Convex functions in `convex/` do NOT hot-reload. After editing any file in `frontend/convex/`, run `make convex-push` from the project root to deploy changes to the self-hosted instance.

@AGENTS.md

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
