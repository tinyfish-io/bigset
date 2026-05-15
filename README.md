<p align="center">
  <img src="assets/banner.svg" alt="BigSet" width="100%" />
</p>

# BigSet

Live, queryable datasets that update automatically. Built on [TinyFish](https://tinyfish.ai) APIs.

Think of it like a spreadsheet that fills itself in — you describe the dataset you want (YC companies currently hiring, insurance quotes in your area, restaurants serving a specific brand), and BigSet builds it, keeps it fresh, and lets you query it with SQL.

Under the hood, BigSet uses TinyFish's Search, Fetch, and Browser APIs to find data, extract it from real websites (even ones that need form fills), and re-run on a schedule so your dataset stays up to date.

## Quick Start

```bash
make dev
```

That's it. Postgres, backend, and frontend all spin up. Open [localhost:3500](http://localhost:3500).

## Project Structure

```
bigset/
├── frontend/          Next.js 16 — the UI
├── backend/           Fastify — API server, auth, database, cron jobs
├── docker-compose.dev.yml
└── Makefile
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, Tailwind 4 |
| Backend | Fastify, TypeScript |
| Auth | Better Auth (email/password, self-hosted) |
| Database | PostgreSQL via Drizzle ORM |
| Data Collection | TinyFish APIs (Search, Fetch, Browser) |

## How It Works

1. You describe a dataset (e.g., "YC companies, with hiring status and funding round")
2. BigSet uses TinyFish Search + Fetch to discover rows and extract data
3. For tricky data (behind forms, login walls), it spins up a Browser session to get it
4. A cron job re-runs the collection on your schedule (every 30 min, hourly, daily)
5. If a collection script breaks, a healer agent patches it automatically

## Status: We're Still Building This!

BigSet is very much a work in progress. We're building this in public because we think it's more fun that way — and because the best ideas usually come from the people who actually want to use the thing.

If you have feedback, ideas, want to help build, or just want to follow along — we'd love to hear from you.

- Follow [TinyFish on Twitter](https://x.com/Tiny_Fish) for project updates
- Follow [Simantak](https://x.com/not_simantak) for the most frequent (and unfiltered) updates

## Contributing

BigSet is open source under the AGPL license. Contributions are very welcome — whether it's code, feedback, or just telling us what datasets you'd want to build.

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Open a PR

If you're not sure where to start, open an issue or come say hi.

## License

[AGPL-3.0](LICENSE)
