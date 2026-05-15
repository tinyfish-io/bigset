# Frontend

Next.js 16, React 19, Tailwind 4. Pure UI — no API routes, no server-side auth.

Auth client in `lib/auth-client.ts` uses `better-auth/react`. `baseURL` points to `localhost:3500` (same origin) — the Next.js rewrite in `next.config.ts` proxies `/api/auth/*` to the backend. Do not point it at the backend directly.

Protected pages use `authClient.useSession()` and redirect to `/auth/sign-in` if no session.

@AGENTS.md
