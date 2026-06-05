<p align="center">
  <img src="assets/banner.svg" alt="BigSet" width="100%" />
</p>

<p align="center">
  <strong>Build and maintain any dataset from the live web, that refreshes regularly</strong>
</p>

<p align="center">
  <a href="https://github.com/tinyfish-io/bigset/stargazers"><img src="https://img.shields.io/github/stars/tinyfish-io/bigset?style=flat" alt="GitHub Stars" /></a>
  <a href="https://github.com/tinyfish-io/bigset/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://github.com/tinyfish-io/bigset/issues"><img src="https://img.shields.io/github/issues/tinyfish-io/bigset" alt="Issues" /></a>
  <a href="https://x.com/Tiny_Fish"><img src="https://img.shields.io/twitter/follow/Tiny_Fish?style=flat" alt="Follow TinyFish" /></a>
</p>

---

> ⚠️ **BigSet is experimental.** It works, sometimes surprisingly well, but expect rough edges. We're building in the open and shipping fast. Things will break, improve, and change. [Issues](https://github.com/tinyfish-io/bigset/issues) and feedback are very welcome.

---

## What Is BigSet?

You type a sentence:

> *"YC companies that are currently hiring engineers, with their funding stage, location, and number of open roles."*

BigSet infers the schema automatically, sends autonomous agents to research it on the live web, verifies what they find against real sources, deduplicates, and hands you a structured dataset. Download as CSV or XLSX. Set a refresh cadence (30 min, 6 hours, 12 hours, daily, weekly) and the agents re-run on schedule, pulling fresh data so the dataset never goes stale.

**Any topic.** GPU prices. Competitor features. Research papers. Restaurant menus. Insurance quotes. Whatever you type, it builds. And keeps current.

You don't pick a scraper, write selectors, or point it at a URL. You just describe the data you care about, set a refresh cadence, and BigSet handles the rest.

Built on [TinyFish](https://www.tinyfish.ai?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2) APIs.


## ✨ Why BigSet?

At the end of the day, every interaction with the web, whether it's you or your AI agent, ultimately comes down to data. Prices, companies, jobs, research, availability, inventory. The web has all of it, scattered across millions of pages.

There are great tools out there for parts of this problem. Scraping frameworks that extract content from URLs you point them at. Search APIs that return ranked results. Pre-built actors for specific sites. Lead gen platforms that produce verified lists of people and companies. They work, and they work well for what they do.

But the moment you need something that cuts across those categories, or something none of them cover, you're back to square one. Stitching together search, extraction, schema design, deduplication, verification, and a cron job to keep it fresh. For every dataset. Every time. The data is right there on the web. Getting it into a table you can use is still a project.

BigSet closes that gap. One sentence in, verified structured data out, refreshed on whatever cadence you set. Your agents get live data to reason over; you get a table you can actually use.

Any dataset. Any source. Always fresh. That's the idea.

### How It Works

1. **You describe the dataset** in plain English, as vague or specific as you like
2. **AI infers the schema**: column names, types, primary keys, where to look on the web
3. **An orchestrator agent** discovers entities via web search
4. **Sub-agents fan out in parallel**: each one investigates a single entity, fetches real data, and inserts a verified row
5. **You get a structured table**: browse it in the UI, export CSV or XLSX
6. **Set a refresh cadence** and the agents re-run on schedule, keeping the dataset current automatically

## Things to Know Before You Start

- **It's experimental.** Expect rough edges; schema inference isn't always perfect, and some topics work better than others.
- **Dataset generation takes 2-5 minutes.** The agents are doing real web research: searching, fetching pages, verifying data. It's not instant, but the output is real.
- **It works best for topics with publicly available web data.** If the information exists on public web pages, BigSet can probably find it. Data behind logins or paywalls is out of reach for now.
- **Scheduled refresh keeps datasets current.** Set a cadence (30 min to weekly) and the agents re-run automatically. No manual re-runs.
- **Datasets are downloadable, not queryable.** You can browse in the UI and export CSV/XLSX. SQL query support is on the roadmap.

---

## 🚀 Quick Start

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and [Make](https://www.gnu.org/software/make/)

You'll also need API keys from three services (all free to set up):

| Service | What it's for | Get your key |
|---------|--------------|-------------|
| **TinyFish** | Web search + page fetching | [tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2) |
| **OpenRouter** | LLM calls (schema inference + agents) | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| **Clerk** | User authentication | [dashboard.clerk.com](https://dashboard.clerk.com) |

### Step 1: Clone the repo

```bash
git clone https://github.com/tinyfish-io/bigset.git
cd bigset
cp .env.example .env
```

### Step 2: Set up TinyFish (web access)

TinyFish powers all web search and page fetching. Search and Fetch have generous rate limits.

1. Go to [tinyfish.ai](https://www.tinyfish.ai?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2) and create an account
2. Go to [API Keys](https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2) and create a key
3. Paste it as `TINYFISH_API_KEY` in `.env`

### Step 3: Set up OpenRouter (LLM)

OpenRouter routes LLM calls to Claude Sonnet (schema inference) and Qwen (agents). It's pay-as-you-go; a dataset costs a few dollars in LLM usage.

1. Go to [openrouter.ai](https://openrouter.ai) and create an account
2. Go to [Settings → Keys](https://openrouter.ai/settings/keys) and create an API key
3. Paste it as `OPENROUTER_API_KEY` in `.env`
4. Add some credits; $5-10 is plenty to start

### Step 4: Set up Clerk (auth)

Clerk handles user sign-in. The setup takes ~2 minutes:

1. Go to [dashboard.clerk.com](https://dashboard.clerk.com) and create a new application
2. Pick a sign-in method (email, Google, GitHub, whatever you prefer)
3. Once created, go to **Configure → API Keys** in the sidebar
   - Copy **Publishable Key** → paste as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `.env`
   - Copy **Secret Key** → paste as `CLERK_SECRET_KEY` in `.env`
4. Go to **Configure → JWT Templates** in the sidebar
   - Click **New template** → select the **Convex** template → click **Save**
5. Go to **Configure → Settings** (or **Domains**)
   - Find your **Issuer URL** (looks like `https://your-app-name.clerk.accounts.dev`)
   - Paste it as `CLERK_JWT_ISSUER_DOMAIN` in `.env`

### Step 5: Start everything

```bash
make dev
```

This installs dependencies, builds and starts all Docker services (Postgres, Convex, frontend, backend, Mastra), and deploys the Convex schema. On first run, it automatically generates the Convex admin key — no manual steps needed. See [How `make dev` Works](#how-make-dev-works) for the full breakdown.

Once everything is ready, you'll see:

| Service | URL |
|---------|-----|
| **BigSet app** | [localhost:3500](http://localhost:3500) |
| **Convex dashboard** | [localhost:6791](http://localhost:6791) |
| **Mastra Studio** (workflow inspector) | [localhost:4111](http://localhost:4111) |

Open [localhost:3500](http://localhost:3500) and click **Get started** to sign in.

> **Note:** root `.env` is the only local env file. If you edit Convex functions in `frontend/convex/`, run `make convex-push` to deploy the changes.

> **Free tier:** each signed-in account gets **2,500 row operations per calendar month** (resets on the 1st, UTC). The header shows a live usage badge; system-owned curated datasets bypass the quota.

### Step 6 (optional): Load curated datasets

BigSet includes 9 curated public datasets (AI companies hiring, GPU prices, model pricing, etc.) that show on the landing page:

```bash
make seed-public-datasets
```

This is idempotent; safe to run multiple times.

---

## How `make dev` Works

`make dev` is designed to handle everything — first run, subsequent runs, and recovery from bad state. You should never need to run any other setup command. Here's what it does, in order:

1. **Validates your `.env`** — checks that all required API keys are set (Clerk, OpenRouter, TinyFish). Stops with a clear error if anything is missing.
2. **Installs dependencies** — runs `npm install` in both `frontend/` and `backend/`. Silent if already up to date.
3. **Starts the database layer** — brings up Postgres and Convex (self-hosted) first, since other services depend on them.
4. **Waits for Convex** — polls the Convex health endpoint until it's ready (up to 120s).
5. **Ensures the admin key** — if `CONVEX_SELF_HOSTED_ADMIN_KEY` is empty in `.env`, generates one automatically and writes it. If a key exists, validates it against the running Convex instance. If the key is stale (e.g. you ran `make clean` and wiped the database), it detects the mismatch and regenerates.
6. **Pushes Convex config** — sets the Clerk JWT issuer URL in Convex so auth tokens are validated correctly.
7. **Deploys Convex schema** — pushes the table schema and functions from `frontend/convex/` to the running instance.
8. **Starts remaining services** — brings up the frontend, backend, and Mastra. These read the now-populated `.env` including the admin key.
9. **Streams logs** — tails all container logs so you can see what's happening. `Ctrl+C` to stop watching (containers keep running).

### Commands

You only need three commands:

| Command | What it does |
|---------|-------------|
| `make dev` | Start everything (or recover from any broken state) |
| `make down` | Stop all containers (data is preserved) |
| `make clean` | Stop containers, delete all data, and clear the admin key |

Other commands you might use during development:

| Command | What it does |
|---------|-------------|
| `make convex-push` | Deploy Convex schema changes (run after editing `frontend/convex/`) |
| `make seed-public-datasets` | Load 9 curated public datasets for the landing page |

### What if something goes wrong?

`make dev` is self-healing. If you hit a problem, the fix is almost always just running `make dev` again.

| Problem | What happens |
|---------|-------------|
| Missing `.env` | Error: "Run: cp .env.example .env" |
| Missing API key | Error tells you exactly which key to set |
| Stale admin key (after `make clean`) | Detected automatically, regenerated |
| Containers already running | No-op for running services, starts any that are missing |
| Convex won't start | Error after 120s timeout — check Docker is running |

If you want a completely fresh start: `make clean` then `make dev`.

---

## Your `.env` at a Glance

| Variable | Required | Where to get it |
|----------|----------|----------------|
| `TINYFISH_API_KEY` | ✅ | [tinyfish.ai](https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2) → API Keys |
| `OPENROUTER_API_KEY` | ✅ | openrouter.ai → Settings → Keys |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | Clerk dashboard → API Keys |
| `CLERK_SECRET_KEY` | ✅ | Clerk dashboard → API Keys |
| `CLERK_JWT_ISSUER_DOMAIN` | ✅ | Clerk dashboard → Settings/Domains |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | Auto | Auto-generated by `make dev` on first run |
| `RESEND_API_KEY` | Optional | For "dataset ready" emails. Leave blank to skip. |
| `NEXT_PUBLIC_POSTHOG_KEY` | Optional | For product analytics. Leave blank to disable. |

---

## 🛠 Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, Tailwind 4 |
| Backend | Fastify, TypeScript (agent runner) |
| Auth | [Clerk](https://clerk.com) |
| Database | [Convex](https://convex.dev) (self-hosted) |
| Data Collection | [TinyFish](https://www.tinyfish.ai?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2) APIs (Search, Fetch, Browser) |
| AI orchestration | [Mastra](https://mastra.ai) workflows + [Vercel AI SDK](https://sdk.vercel.ai) + [OpenRouter](https://openrouter.ai) → Claude Sonnet (schema inference + populate agent) |
| Table view | [TanStack Table](https://tanstack.com/table) + [react-window](https://github.com/bvaughn/react-window) virtualization |
| Exports | CSV (built-in) + XLSX ([SheetJS](https://sheetjs.com), dynamic-imported) |
| Analytics | [PostHog](https://posthog.com) — events, session replay, error tracking (optional) |

## 📁 Project Structure

```text
bigset/
├── frontend/            Next.js 16 — UI + Convex schema & functions
│   ├── convex/          Convex functions, schema, authz + quota helpers
├── backend/             Fastify + Mastra — schema inference + populate agent
│   ├── src/pipeline/    Pure pipelines: schema inference + populate context
│   ├── src/mastra/      Mastra workflows, agents, and tools (Studio at :4111 in dev)
│   ├── src/email/       Transactional email (Resend) — sends "dataset ready" notifications
│   └── src/analytics/   Server-side PostHog wrapper for backend-only events
├── scripts/             One-off scripts (e.g. verify-authz.sh)
├── .env                 Local env for frontend, backend, Convex CLI, and Docker (not committed)
├── docker-compose.dev.yml
└── Makefile
```

---

## 🛣️ Roadmap

We're building BigSet in the open. Here's what's coming:

- [ ] **TinyFish Browser + Agent integration** — For JS-heavy sites, SPAs, and pages that need interaction to reveal data.
- [ ] **Agent-native API** — So your agents can create, query, and consume BigSet datasets programmatically. Build datasets on the fly, export them, feed them to your agents today. Next up: agents generate and query datasets directly.
- [ ] **SQL query layer** — Query your datasets with SQL instead of just exporting.
- [ ] **Per-cell source provenance** — Click any cell to see exactly where the data came from.
- [ ] **Healer agents** — Automatically detect and fix broken or stale rows.
- [ ] **Incremental updates** — Refresh only what changed instead of rebuilding the whole dataset.

---

## 🏗 Building in Public

BigSet is a work in progress. We're building in the open because the best ideas come from the people who actually want to use the thing.

We'd love your feedback, ideas, or help building — come say hi:

- 🐦 **Twitter:** [@Tiny_Fish](https://x.com/Tiny_Fish) for project updates
- 🗣 **Twitter:** [@not_simantak](https://x.com/not_simantak) for the unfiltered version
- 🐛 **GitHub Issues:** [Report bugs or request features](https://github.com/tinyfish-io/bigset/issues)


## Star History

<p align="center">
  <a href="https://www.star-history.com/#tinyfish-io/bigset&type=date">
    <img src="https://api.star-history.com/svg?repos=tinyfish-io/bigset&type=date&legend=top-left" alt="Star History Chart">
  </a>
</p>


## 🤝 Contributing

<a href="https://github.com/tinyfish-io/bigset/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=tinyfish-io/bigset" />
</a>

^ This awesome team is behing BigSet! We'd love to have you on board :) 

Contributions are very welcome — whether it's code, feedback, or just telling us what datasets you'd want to build.

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `bash scripts/verify-authz.sh` to confirm the authorization layer still holds
5. Open a PR

If you're not sure where to start, [open an issue](https://github.com/tinyfish-io/bigset/issues) or come say hi.

## 📄 License

[AGPL-3.0](LICENSE)
