# BigSet Frontend

Next.js 16 app — the UI for BigSet.

## Running

```bash
bun install
bun dev --port 3500
```

Opens on [localhost:3500](http://localhost:3500). Package scripts load root
`.env` before starting Next.js. The supported full-stack dev path is still
`make dev` from the repo root.

## Key Paths

- `app/page.tsx` — Landing page
- `app/sign-in/` and `app/sign-up/` — Clerk sign in + sign up
- `app/dashboard/` — Main dashboard (protected)
- `lib/backend.ts` — Backend API client
- `proxy.ts` — Clerk route protection

## Scripts

| Command | What it does |
|---------|-------------|
| `bun dev --port 3500` | Start dev server |
| `bun run build` | Production build |
| `bun run lint` | ESLint |
