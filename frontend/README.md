# BigSet Frontend

Next.js 16 app — the UI for BigSet.

## Running

```bash
bun install
bun dev --port 3500
```

Opens on [localhost:3500](http://localhost:3500). Expects the backend running on 3501 (auth requests are proxied via Next.js rewrites).

## Key Paths

- `app/page.tsx` — Landing page
- `app/auth/` — Sign in + sign up
- `app/dashboard/` — Main dashboard (protected)
- `lib/auth-client.ts` — Better Auth React client
- `next.config.ts` — Rewrites `/api/auth/*` to the backend

## Scripts

| Command | What it does |
|---------|-------------|
| `bun dev --port 3500` | Start dev server |
| `bun run build` | Production build |
| `bun run lint` | ESLint |
