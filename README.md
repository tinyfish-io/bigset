<p align="center">
  <img src="assets/banner.svg" alt="BigSet" width="100%" />
</p>

<p align="center">
  <strong>Live, queryable datasets that update automatically.</strong>
</p>

<p align="center">
  <a href="https://github.com/tinyfish-io/bigset/stargazers"><img src="https://img.shields.io/github/stars/tinyfish-io/bigset?style=flat" alt="GitHub Stars" /></a>
  <a href="https://github.com/tinyfish-io/bigset/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://github.com/tinyfish-io/bigset/issues"><img src="https://img.shields.io/github/issues/tinyfish-io/bigset" alt="Issues" /></a>
  <a href="https://x.com/Tiny_Fish"><img src="https://img.shields.io/twitter/follow/Tiny_Fish?style=flat" alt="Follow TinyFish" /></a>
</p>

---

Think of it like a spreadsheet that fills itself in — you describe the dataset you want (YC companies currently hiring, insurance quotes in your area, restaurants serving a specific brand), and BigSet builds it, keeps it fresh, and lets you query it with SQL.

Built on [TinyFish](https://tinyfish.ai) APIs.

## ✨ Why BigSet?

At the end of the day, the only thing that matters is data. Every decision, every agent, every product — it all comes down to having the right data at the right time.

So what if you could just… ask for it? Describe the dataset you want — in plain English — and have it built, structured, and kept fresh automatically. No scrapers to maintain. No pipelines to babysit. No waking up to broken cron jobs because some site changed a div.

You describe it. BigSet collects it. Your agents query it with SQL. It stays up to date on your schedule — every 30 minutes, every hour, whatever you need. And if something breaks, a healer agent patches it before you even notice.

Any dataset. Any source. Always fresh. That's the idea.

---

## 🚀 Quick Start

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/), [Make](https://www.gnu.org/software/make/), and a free [Clerk](https://dashboard.clerk.com) account

### 1. Clone and set up Clerk

```bash
git clone https://github.com/tinyfish-io/bigset.git
cd bigset
```

Create a Clerk application at [dashboard.clerk.com](https://dashboard.clerk.com), then go to **JWT Templates** and enable the **Convex** template.

### 2. Configure env files

```bash
# Root .env — used by Docker for the frontend container
cp .env.example .env
# Fill in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY

# Frontend .env.local — used by Next.js and Convex CLI
cp frontend/.env.example frontend/.env.local
# Fill in all three Clerk keys (publishable, secret, and JWT issuer domain)
```

> **Required for the create-dataset wizard:** set `OPENROUTER_API_KEY` (used by the schema-inference pipeline). Get one at [openrouter.ai](https://openrouter.ai). Without it the wizard's "Generate Schema" step will fail.

> **Optional:** to enable [PostHog](https://posthog.com) product analytics + session replay + error tracking, set `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`. Leave blank to disable cleanly (the app no-ops every event).

### 3. Start everything

```bash
make dev
```

This starts all Docker services, waits for Convex to be healthy, and deploys Convex functions automatically. Once it's up:

- App: http://localhost:3500
- Convex dashboard: http://localhost:6791
- [Mastra Studio](https://mastra.ai) (workflow inspector): http://localhost:4111

### 4. Generate Convex admin key (first time only)

```bash
docker compose exec convex ./generate_admin_key.sh
```

Paste the output into `frontend/.env.local` as `CONVEX_SELF_HOSTED_ADMIN_KEY`, then re-run `make dev`.

### 5. Load curated public datasets

The landing page and the dashboard's "Curated" section read from a set of 9 system-owned datasets. Load them with:

```bash
cd frontend
npx convex run publicSeed:seedPublicDatasets
```

The script is **idempotent** — rerunning it skips datasets that already exist (matched by a stable `seedKey`, so renaming a curated dataset never creates a duplicate). To add a 10th curated dataset, append it to `PUBLIC_DATASETS` in [frontend/convex/publicSeed.ts](frontend/convex/publicSeed.ts) with a fresh `seedKey` and rerun the command. To replace existing curated content in place, pass `force: true`:

```bash
npx convex run publicSeed:seedPublicDatasets '{"force":true}'
```

Open [localhost:3500](http://localhost:3500) and click **Get started** to sign in.

> **Note:** Backend env needs no setup — `backend/.env.example` has correct defaults. If you edit Convex functions in `frontend/convex/`, run `make convex-push` to deploy the changes.

> **Free tier:** each signed-in account gets **2,500 row operations per calendar month** (resets on the 1st, UTC). The header shows a live usage badge; system-owned curated datasets bypass the quota.

---

## 🛠 Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, Tailwind 4 |
| Backend | Fastify, TypeScript (agent runner) |
| Auth | [Clerk](https://clerk.com) |
| Database | [Convex](https://convex.dev) (self-hosted) |
| Data Collection | [TinyFish](https://tinyfish.ai) APIs (Search, Fetch, Browser) |
| Schema inference | [Mastra](https://mastra.ai) workflows + [Vercel AI SDK](https://sdk.vercel.ai) + [OpenRouter](https://openrouter.ai) → Claude Sonnet |
| Table view | [TanStack Table](https://tanstack.com/table) + [react-window](https://github.com/bvaughn/react-window) virtualization |
| Exports | CSV (built-in) + XLSX ([SheetJS](https://sheetjs.com), dynamic-imported) |
| Analytics | [PostHog](https://posthog.com) — events, session replay, error tracking (optional) |

## 📁 Project Structure

```text
bigset/
├── frontend/            Next.js 16 — UI + Convex schema & functions
│   ├── convex/          Convex functions, schema, authz + quota helpers
│   └── .env.local       Clerk + Convex keys (not committed)
├── backend/             Fastify + Mastra — schema inference + (future) agents
│   ├── src/pipeline/    Pure schema-inference fn (called by Fastify + Mastra)
│   └── src/mastra/      Mastra workflows (Studio at :4111 in dev)
├── scripts/             One-off scripts (e.g. verify-authz.sh)
├── .env                 Clerk keys for docker-compose (not committed)
├── docker-compose.dev.yml
└── Makefile
```

---

## 🏗 Building in Public

BigSet is a work in progress. We're building in the open because the best ideas come from the people who actually want to use the thing.

We'd love your feedback, ideas, or help building — come say hi:

- 🐦 **Twitter:** [@Tiny_Fish](https://x.com/Tiny_Fish) for project updates
- 🗣 **Twitter:** [@not_simantak](https://x.com/not_simantak) for the unfiltered version
- 🐛 **GitHub Issues:** [Report bugs or request features](https://github.com/tinyfish-io/bigset/issues)

## 🤝 Contributing

Contributions are very welcome — whether it's code, feedback, or just telling us what datasets you'd want to build.

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `bash scripts/verify-authz.sh` to confirm the authorization layer still holds
5. Open a PR

If you're not sure where to start, [open an issue](https://github.com/tinyfish-io/bigset/issues) or come say hi.

## 📄 License

[AGPL-3.0](LICENSE)
