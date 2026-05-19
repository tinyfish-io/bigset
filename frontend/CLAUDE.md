# Frontend

Next.js 16, React 19, Tailwind 4. Pure UI — no API routes, no server-side auth logic.

Auth uses `@clerk/nextjs`. `ClerkProvider` wraps the app in `layout.tsx`, `ConvexProviderWithClerk` bridges Clerk tokens to Convex in `convex-provider.tsx`. Protected routes enforced by `proxy.ts` (Clerk middleware). Sign-in/sign-up pages at `/sign-in` and `/sign-up` use Clerk's built-in components.

Use `useConvexAuth()` from `convex/react` (not Clerk's `useAuth()`) to check auth state in components. Use `useUser()` from `@clerk/nextjs` for user info (email, name). Use `useClerk()` for sign-out.

Convex functions in `convex/` do NOT hot-reload. After editing any file in `frontend/convex/`, run `make convex-push` from the project root to deploy changes to the self-hosted instance.

@AGENTS.md
