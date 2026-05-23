# Frontend — Agent Guidelines

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Do not add API routes here. All backend logic lives in `backend/`.

Auth uses Clerk (`@clerk/nextjs`) with Convex integration (`ConvexProviderWithClerk`). Do not use Better Auth, Next.js server actions, or custom auth middleware. Clerk proxy in `proxy.ts` handles route protection.

After editing any file in `frontend/convex/`, you MUST run `make convex-push` from the project root. Convex is self-hosted and does not hot-reload — without the push, the running instance still has the old code.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
