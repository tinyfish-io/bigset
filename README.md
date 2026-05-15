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

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and [Make](https://www.gnu.org/software/make/)

```bash
git clone https://github.com/tinyfish-io/bigset.git
cd bigset
make dev
```

That's it. Postgres, backend, and frontend all spin up. Open [localhost:3500](http://localhost:3500).

---

## 🛠 Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, Tailwind 4 |
| Backend | Fastify, TypeScript |
| Auth | Better Auth (email/password, self-hosted) |
| Database | PostgreSQL via Drizzle ORM |
| Data Collection | TinyFish APIs (Search, Fetch, Browser) |

## 📁 Project Structure

```
bigset/
├── frontend/          Next.js 16 — the UI
├── backend/           Fastify — API server, auth, database, cron jobs
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
4. Open a PR

If you're not sure where to start, [open an issue](https://github.com/tinyfish-io/bigset/issues) or come say hi.

## 📄 License

[AGPL-3.0](LICENSE)
