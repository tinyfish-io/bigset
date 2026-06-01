import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import {
  nextRefreshAtFor,
  type RefreshCadence,
} from "./lib/refreshScheduling.js";

/**
 * Idempotent loader for the curated public datasets that appear on the
 * landing page and the dashboard's "Curated" section.
 *
 * Run from the frontend/ directory:
 *
 *     npx convex run publicSeed:seedPublicDatasets
 *
 * Internal mutation (admin-key only): not callable from a browser. The
 * datasets are owned by the `system` sentinel — no Clerk user can mutate
 * them, only this script can.
 *
 * Idempotency:
 *   - Existing datasets are matched by `seedKey` (a stable, immutable
 *     identifier carried on each entry). If a dataset with the same
 *     seedKey already exists under `ownerId: system`, it is skipped.
 *   - `name`, `description`, `refreshCadence`, and other fields can change
 *     freely on subsequent runs without creating duplicates. They are
 *     NOT re-synced to the live row — patches in place are a deliberate
 *     future enhancement (see `backfilled` path below for the pattern).
 *   - To force a content refresh of an existing curated dataset, delete
 *     it from the Convex dashboard, then rerun this script.
 *
 * Migration from name-based dedup (pre-seedKey datasets):
 *   - On first run after this change, any system-owned dataset that
 *     lacks a seedKey but whose name matches an entry will be PATCHED
 *     to adopt the seedKey. Counted in the return value as `backfilled`.
 *
 * Adding a new curated dataset:
 *   - Append an entry to PUBLIC_DATASETS below with a fresh `seedKey`
 *     (kebab-case, e.g. "new-thing-tracker"). NEVER reuse a seedKey.
 *   - Re-run `npx convex run publicSeed:seedPublicDatasets`
 *   - Only the new entry inserts; existing ones are skipped by seedKey
 *
 * Production:
 *   Same command, run against the prod deployment with
 *   CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY set to prod values.
 */

export const SYSTEM_OWNER_ID = "system";

type ColType = "text" | "number" | "boolean" | "url" | "date";

interface PublicDatasetDef {
  /**
   * Stable identifier for this curated dataset across all environments
   * and across renames. NEVER change a seedKey once shipped — that's the
   * whole point of the field. Use kebab-case, namespaced loosely by
   * topic. Examples: "yc-w26-hiring", "gpu-prices-retail".
   */
  seedKey: string;
  name: string;
  description: string;
  refreshCadence: RefreshCadence;
  columns: { name: string; type: ColType; description?: string }[];
  rows: Record<string, string>[];
}

// Note on data sourcing: these are CURATED snapshots, not live scrapes.
// Until the agent runner ships (problem #4 in the spec), public datasets
// reflect publicly-known facts about real entities (real companies, real
// repositories, real model pricing) captured at curation time. Numerical
// fields like row counts or star counts are approximations.
const PUBLIC_DATASETS: PublicDatasetDef[] = [
  {
    seedKey: "yc-w26-hiring",
    name: "AI-Native Companies Hiring Engineers",
    description:
      "Engineering hiring across the AI tooling, dev-tools, and agent ecosystem. Companies and stages reflect publicly known facts; role counts are approximate.",
    refreshCadence: "daily",
    columns: [
      { name: "Company", type: "text" },
      { name: "Product", type: "text" },
      { name: "Stage", type: "text" },
      { name: "Open Roles", type: "number" },
      { name: "Location", type: "text" },
      { name: "Website", type: "url" },
    ],
    rows: [
      { Company: "Anthropic", Product: "Claude models + API", Stage: "Late stage", "Open Roles": "180", Location: "San Francisco", Website: "anthropic.com" },
      { Company: "OpenAI", Product: "GPT models + ChatGPT", Stage: "Late stage", "Open Roles": "240", Location: "San Francisco", Website: "openai.com" },
      { Company: "Cursor", Product: "AI code editor", Stage: "Series C", "Open Roles": "35", Location: "San Francisco", Website: "cursor.com" },
      { Company: "Vercel", Product: "Frontend platform + AI SDK", Stage: "Series E", "Open Roles": "55", Location: "Remote", Website: "vercel.com" },
      { Company: "Linear", Product: "Issue tracking for software teams", Stage: "Series B", "Open Roles": "12", Location: "Remote", Website: "linear.app" },
      { Company: "Replicate", Product: "Run open-source ML in the cloud", Stage: "Series B", "Open Roles": "8", Location: "San Francisco", Website: "replicate.com" },
      { Company: "Modal", Product: "Serverless compute for ML", Stage: "Series A", "Open Roles": "14", Location: "New York", Website: "modal.com" },
      { Company: "Resend", Product: "Email API for developers", Stage: "Series A", "Open Roles": "9", Location: "San Francisco", Website: "resend.com" },
      { Company: "Mintlify", Product: "Documentation platform for APIs", Stage: "Series A", "Open Roles": "8", Location: "San Francisco", Website: "mintlify.com" },
      { Company: "Neon", Product: "Serverless Postgres with branching", Stage: "Series B", "Open Roles": "18", Location: "Remote", Website: "neon.tech" },
      { Company: "Convex", Product: "Reactive backend platform", Stage: "Series A", "Open Roles": "14", Location: "Seattle", Website: "convex.dev" },
      { Company: "Browserbase", Product: "Browser infra for AI agents", Stage: "Series B", "Open Roles": "11", Location: "New York", Website: "browserbase.com" },
    ],
  },
  {
    seedKey: "gpu-prices-retail",
    name: "NVIDIA Consumer GPU Retail Prices",
    description:
      "Retail prices for current-generation NVIDIA Founders Edition cards across major US retailers, reflecting public MSRPs and observed street prices.",
    refreshCadence: "30m",
    columns: [
      { name: "Model", type: "text" },
      { name: "MSRP", type: "number" },
      { name: "Retailer", type: "text" },
      { name: "Street Price", type: "number" },
      { name: "In Stock", type: "boolean" },
      { name: "URL", type: "url" },
    ],
    rows: [
      { Model: "RTX 5090 FE 32GB", MSRP: "$1,999", Retailer: "Newegg", "Street Price": "$1,999", "In Stock": "Yes", URL: "newegg.com" },
      { Model: "RTX 5090 FE 32GB", MSRP: "$1,999", Retailer: "Best Buy", "Street Price": "$1,999", "In Stock": "No", URL: "bestbuy.com" },
      { Model: "RTX 5090 FE 32GB", MSRP: "$1,999", Retailer: "Amazon (3rd party)", "Street Price": "$2,149", "In Stock": "Yes", URL: "amazon.com" },
      { Model: "RTX 5090 FE 32GB", MSRP: "$1,999", Retailer: "Micro Center", "Street Price": "$1,979", "In Stock": "Yes", URL: "microcenter.com" },
      { Model: "RTX 5080 FE 16GB", MSRP: "$999", Retailer: "Newegg", "Street Price": "$999", "In Stock": "Yes", URL: "newegg.com" },
      { Model: "RTX 5080 FE 16GB", MSRP: "$999", Retailer: "Best Buy", "Street Price": "$999", "In Stock": "Yes", URL: "bestbuy.com" },
      { Model: "RTX 4090 FE 24GB", MSRP: "$1,599", Retailer: "Newegg", "Street Price": "$1,699", "In Stock": "Yes", URL: "newegg.com" },
      { Model: "RTX 4090 FE 24GB", MSRP: "$1,599", Retailer: "Amazon", "Street Price": "$1,749", "In Stock": "Yes", URL: "amazon.com" },
      { Model: "RTX 4080 SUPER 16GB", MSRP: "$999", Retailer: "Newegg", "Street Price": "$999", "In Stock": "Yes", URL: "newegg.com" },
    ],
  },
  {
    seedKey: "oss-ai-repos",
    name: "Top Open-Source AI Repositories",
    description:
      "Most-starred AI/ML repositories on GitHub. Star counts are rounded approximations sourced from public GitHub metadata at curation time.",
    refreshCadence: "daily",
    columns: [
      { name: "Repo", type: "text" },
      { name: "Stars", type: "number" },
      { name: "Language", type: "text" },
      { name: "License", type: "text" },
      { name: "URL", type: "url" },
    ],
    rows: [
      { Repo: "huggingface/transformers", Stars: "135,000", Language: "Python", License: "Apache-2.0", URL: "github.com/huggingface/transformers" },
      { Repo: "ollama/ollama", Stars: "105,000", Language: "Go", License: "MIT", URL: "github.com/ollama/ollama" },
      { Repo: "langchain-ai/langchain", Stars: "98,000", Language: "Python", License: "MIT", URL: "github.com/langchain-ai/langchain" },
      { Repo: "open-webui/open-webui", Stars: "85,000", Language: "Svelte", License: "BSD-3", URL: "github.com/open-webui/open-webui" },
      { Repo: "ggerganov/llama.cpp", Stars: "75,000", Language: "C++", License: "MIT", URL: "github.com/ggerganov/llama.cpp" },
      { Repo: "comfyanonymous/ComfyUI", Stars: "62,000", Language: "Python", License: "GPL-3.0", URL: "github.com/comfyanonymous/ComfyUI" },
      { Repo: "lobehub/lobe-chat", Stars: "55,000", Language: "TypeScript", License: "Apache-2.0", URL: "github.com/lobehub/lobe-chat" },
      { Repo: "All-Hands-AI/OpenHands", Stars: "42,000", Language: "Python", License: "MIT", URL: "github.com/All-Hands-AI/OpenHands" },
      { Repo: "vllm-project/vllm", Stars: "38,000", Language: "Python", License: "Apache-2.0", URL: "github.com/vllm-project/vllm" },
      { Repo: "microsoft/autogen", Stars: "35,000", Language: "Python", License: "MIT", URL: "github.com/microsoft/autogen" },
      { Repo: "modelcontextprotocol/servers", Stars: "32,000", Language: "TypeScript", License: "MIT", URL: "github.com/modelcontextprotocol/servers" },
      { Repo: "stanfordnlp/dspy", Stars: "21,000", Language: "Python", License: "MIT", URL: "github.com/stanfordnlp/dspy" },
    ],
  },
  {
    seedKey: "ai-model-pricing",
    name: "Frontier AI Model Pricing",
    description:
      "Per-million-token API pricing and context windows for production AI models. Values reflect published rates on each provider's pricing page.",
    refreshCadence: "weekly",
    columns: [
      { name: "Provider", type: "text" },
      { name: "Model", type: "text" },
      { name: "Input $ / 1M", type: "number" },
      { name: "Output $ / 1M", type: "number" },
      { name: "Context", type: "text" },
      { name: "Docs", type: "url" },
    ],
    rows: [
      { Provider: "Anthropic", Model: "Claude Opus 4.7", "Input $ / 1M": "$15.00", "Output $ / 1M": "$75.00", Context: "200K", Docs: "anthropic.com/pricing" },
      { Provider: "Anthropic", Model: "Claude Sonnet 4.6", "Input $ / 1M": "$3.00", "Output $ / 1M": "$15.00", Context: "200K", Docs: "anthropic.com/pricing" },
      { Provider: "Anthropic", Model: "Claude Haiku 4.5", "Input $ / 1M": "$0.80", "Output $ / 1M": "$4.00", Context: "200K", Docs: "anthropic.com/pricing" },
      { Provider: "OpenAI", Model: "GPT-5", "Input $ / 1M": "$10.00", "Output $ / 1M": "$30.00", Context: "256K", Docs: "openai.com/api/pricing" },
      { Provider: "OpenAI", Model: "GPT-5 mini", "Input $ / 1M": "$1.50", "Output $ / 1M": "$6.00", Context: "128K", Docs: "openai.com/api/pricing" },
      { Provider: "Google", Model: "Gemini 2.5 Pro", "Input $ / 1M": "$2.50", "Output $ / 1M": "$10.00", Context: "2M", Docs: "ai.google.dev/pricing" },
      { Provider: "Google", Model: "Gemini 2.5 Flash", "Input $ / 1M": "$0.15", "Output $ / 1M": "$0.60", Context: "1M", Docs: "ai.google.dev/pricing" },
      { Provider: "Mistral", Model: "Mistral Large 2", "Input $ / 1M": "$2.00", "Output $ / 1M": "$6.00", Context: "128K", Docs: "mistral.ai/pricing" },
      { Provider: "DeepSeek", Model: "DeepSeek V3", "Input $ / 1M": "$0.27", "Output $ / 1M": "$1.10", Context: "128K", Docs: "platform.deepseek.com" },
      { Provider: "xAI", Model: "Grok 3", "Input $ / 1M": "$3.00", "Output $ / 1M": "$15.00", Context: "131K", Docs: "x.ai/api" },
    ],
  },
  {
    seedKey: "browser-automation-landscape",
    name: "Browser Automation & Web Agent Companies",
    description:
      "Companies building browser-control APIs, headless browser infrastructure, and agentic web scraping. Funding totals are public disclosures.",
    refreshCadence: "weekly",
    columns: [
      { name: "Company", type: "text" },
      { name: "Product", type: "text" },
      { name: "Latest Round", type: "text" },
      { name: "Open Source", type: "boolean" },
      { name: "Website", type: "url" },
    ],
    rows: [
      { Company: "Browserbase", Product: "Headless browser infra for AI agents", "Latest Round": "Series B", "Open Source": "No", Website: "browserbase.com" },
      { Company: "Apify", Product: "Web scraping + automation platform", "Latest Round": "Series B", "Open Source": "Partial", Website: "apify.com" },
      { Company: "Browser Use", Product: "Open-source browser agent framework", "Latest Round": "Seed", "Open Source": "Yes", Website: "browser-use.com" },
      { Company: "Bright Data", Product: "Proxy network + scraping APIs", "Latest Round": "Acquired by EMK Capital", "Open Source": "No", Website: "brightdata.com" },
      { Company: "TinyFish", Product: "Web agent APIs (Search/Fetch/Browser)", "Latest Round": "Series A", "Open Source": "No", Website: "tinyfish.ai" },
      { Company: "Firecrawl", Product: "LLM-ready web scraping API", "Latest Round": "Series A", "Open Source": "Yes", Website: "firecrawl.dev" },
      { Company: "ScrapingBee", Product: "Headless browser API for scraping", "Latest Round": "Seed", "Open Source": "No", Website: "scrapingbee.com" },
      { Company: "Zyte", Product: "Enterprise web data extraction", "Latest Round": "Series A", "Open Source": "Partial", Website: "zyte.com" },
      { Company: "Anchor Browser", Product: "Cloud browsers for AI workflows", "Latest Round": "Seed", "Open Source": "No", Website: "anchorbrowser.io" },
      { Company: "Steel.dev", Product: "Open-source browser API for AI agents", "Latest Round": "Pre-seed", "Open Source": "Yes", Website: "steel.dev" },
    ],
  },
  {
    seedKey: "cloud-h100-pricing",
    name: "H100 Cloud GPU Pricing",
    description:
      "Per-GPU per-hour pricing for NVIDIA H100 80GB across hyperscalers and specialty cloud providers. AWS/GCP/Azure prices are full-node rates normalized to 1× H100.",
    refreshCadence: "daily",
    columns: [
      { name: "Provider", type: "text" },
      { name: "Per-GPU $ / hr", type: "number" },
      { name: "Tier", type: "text" },
      { name: "Min Commit", type: "text" },
      { name: "Website", type: "url" },
    ],
    rows: [
      { Provider: "Lambda Labs", "Per-GPU $ / hr": "$2.49", Tier: "Specialty", "Min Commit": "None", Website: "lambdalabs.com" },
      { Provider: "RunPod", "Per-GPU $ / hr": "$2.69", Tier: "Specialty", "Min Commit": "None", Website: "runpod.io" },
      { Provider: "Together AI", "Per-GPU $ / hr": "$2.39", Tier: "Specialty", "Min Commit": "None", Website: "together.ai" },
      { Provider: "Crusoe", "Per-GPU $ / hr": "$2.40", Tier: "Specialty", "Min Commit": "None", Website: "crusoecloud.com" },
      { Provider: "CoreWeave", "Per-GPU $ / hr": "$2.23", Tier: "Specialty", "Min Commit": "1 year reserved", Website: "coreweave.com" },
      { Provider: "Fluidstack", "Per-GPU $ / hr": "$1.95", Tier: "Specialty", "Min Commit": "None", Website: "fluidstack.io" },
      { Provider: "AWS p5", "Per-GPU $ / hr": "$12.29", Tier: "Hyperscaler", "Min Commit": "None", Website: "aws.amazon.com/ec2/instance-types/p5" },
      { Provider: "GCP a3-highgpu", "Per-GPU $ / hr": "$11.06", Tier: "Hyperscaler", "Min Commit": "None", Website: "cloud.google.com/compute/gpus-pricing" },
      { Provider: "Azure ND H100 v5", "Per-GPU $ / hr": "$11.78", Tier: "Hyperscaler", "Min Commit": "None", Website: "azure.microsoft.com" },
    ],
  },
  {
    seedKey: "vc-funding-rounds",
    name: "Notable AI Company Funding Rounds",
    description:
      "Significant venture rounds raised by AI companies. Round names, amounts, and lead investors are drawn from public funding announcements.",
    refreshCadence: "daily",
    columns: [
      { name: "Company", type: "text" },
      { name: "Round", type: "text" },
      { name: "Amount", type: "text" },
      { name: "Lead Investor", type: "text" },
      { name: "Sector", type: "text" },
    ],
    rows: [
      { Company: "Anthropic", Round: "Series F", Amount: "$3.5B+", "Lead Investor": "Lightspeed Venture Partners", Sector: "Foundation Models" },
      { Company: "OpenAI", Round: "Late Stage", Amount: "$6.6B", "Lead Investor": "Thrive Capital", Sector: "Foundation Models" },
      { Company: "xAI", Round: "Series C", Amount: "$6B", "Lead Investor": "Valor / Sequoia (multiple)", Sector: "Foundation Models" },
      { Company: "Mistral AI", Round: "Series B", Amount: "$640M", "Lead Investor": "General Catalyst", Sector: "Foundation Models" },
      { Company: "Cursor", Round: "Series B+", Amount: "$105M", "Lead Investor": "Thrive Capital", Sector: "AI Coding" },
      { Company: "Perplexity", Round: "Series B", Amount: "$73.6M", "Lead Investor": "IVP", Sector: "AI Search" },
      { Company: "Sierra", Round: "Series A", Amount: "$110M", "Lead Investor": "Greenoaks", Sector: "AI Agents" },
      { Company: "ElevenLabs", Round: "Series B", Amount: "$80M", "Lead Investor": "Andreessen Horowitz", Sector: "Voice AI" },
      { Company: "Decagon", Round: "Series B", Amount: "$65M", "Lead Investor": "Bain Capital Ventures", Sector: "AI Support" },
      { Company: "Browserbase", Round: "Series A", Amount: "$21M", "Lead Investor": "CRV", Sector: "Browser Infra" },
    ],
  },
  {
    // Note: this seedKey is internally named after the prior dataset
    // (`ph-dev-tool-launches`) — kept stable to preserve dedup history.
    // The user-facing content is now AI Coding Tools.
    seedKey: "ph-dev-tool-launches",
    name: "AI Coding Tools Landscape",
    description:
      "Editors, CLIs, and extensions that ship with AI-powered coding. Pricing and underlying-model fields reflect each tool's public docs.",
    refreshCadence: "weekly",
    columns: [
      { name: "Product", type: "text" },
      { name: "Type", type: "text" },
      { name: "Maker", type: "text" },
      { name: "Free Tier", type: "boolean" },
      { name: "Paid From", type: "text" },
      { name: "Underlying Models", type: "text" },
      { name: "Website", type: "url" },
    ],
    rows: [
      { Product: "Cursor", Type: "Standalone IDE", Maker: "Anysphere", "Free Tier": "Yes", "Paid From": "$20/mo", "Underlying Models": "Claude, GPT, Gemini", Website: "cursor.com" },
      { Product: "Claude Code", Type: "CLI + extension", Maker: "Anthropic", "Free Tier": "No", "Paid From": "API usage", "Underlying Models": "Claude (Opus/Sonnet)", Website: "claude.com/code" },
      { Product: "GitHub Copilot", Type: "Extension", Maker: "GitHub", "Free Tier": "Yes", "Paid From": "$10/mo", "Underlying Models": "GPT-4.x + Claude", Website: "github.com/copilot" },
      { Product: "Windsurf", Type: "Standalone IDE", Maker: "Codeium", "Free Tier": "Yes", "Paid From": "$15/mo", "Underlying Models": "Multiple", Website: "windsurf.com" },
      { Product: "Cline", Type: "Extension (VS Code)", Maker: "Open source", "Free Tier": "Yes", "Paid From": "BYOK", "Underlying Models": "Claude, GPT, etc.", Website: "cline.bot" },
      { Product: "Aider", Type: "CLI", Maker: "Open source", "Free Tier": "Yes", "Paid From": "BYOK", "Underlying Models": "Claude, GPT, etc.", Website: "aider.chat" },
      { Product: "Continue", Type: "Extension", Maker: "Continue", "Free Tier": "Yes", "Paid From": "$0 (BYOK)", "Underlying Models": "Multiple", Website: "continue.dev" },
      { Product: "Zed", Type: "Standalone IDE", Maker: "Zed Industries", "Free Tier": "Yes", "Paid From": "$20/mo (AI)", "Underlying Models": "Claude, GPT", Website: "zed.dev" },
      { Product: "Cody", Type: "Extension", Maker: "Sourcegraph", "Free Tier": "Yes", "Paid From": "$9/mo", "Underlying Models": "Claude, GPT", Website: "sourcegraph.com/cody" },
      { Product: "JetBrains AI", Type: "IDE built-in", Maker: "JetBrains", "Free Tier": "Limited", "Paid From": "$10/mo", "Underlying Models": "Multiple", Website: "jetbrains.com/ai" },
    ],
  },
  {
    seedKey: "observability-pricing",
    name: "Observability SaaS Pricing Comparison",
    description:
      "Starting price, log-ingest rate, and free-tier limits for the leading observability platforms. Values reflect each vendor's published pricing page.",
    refreshCadence: "weekly",
    columns: [
      { name: "Vendor", type: "text" },
      { name: "Starter $ / mo", type: "number" },
      { name: "Logs $ / GB", type: "number" },
      { name: "Free Tier", type: "text" },
      { name: "Per-Host Pricing", type: "boolean" },
      { name: "Website", type: "url" },
    ],
    rows: [
      { Vendor: "Datadog", "Starter $ / mo": "$15", "Logs $ / GB": "$0.10", "Free Tier": "5 hosts × 14 days", "Per-Host Pricing": "Yes", Website: "datadoghq.com/pricing" },
      { Vendor: "New Relic", "Starter $ / mo": "$0", "Logs $ / GB": "$0.30", "Free Tier": "100 GB / month", "Per-Host Pricing": "No", Website: "newrelic.com/pricing" },
      { Vendor: "Grafana Cloud", "Starter $ / mo": "$0", "Logs $ / GB": "$0.50", "Free Tier": "50 GB logs + 10K series", "Per-Host Pricing": "No", Website: "grafana.com/pricing" },
      { Vendor: "Honeycomb", "Starter $ / mo": "$130", "Logs $ / GB": "—", "Free Tier": "20M events / month", "Per-Host Pricing": "No", Website: "honeycomb.io/pricing" },
      { Vendor: "Axiom", "Starter $ / mo": "$25", "Logs $ / GB": "$0.25", "Free Tier": "500 GB / month", "Per-Host Pricing": "No", Website: "axiom.co/pricing" },
      { Vendor: "Better Stack", "Starter $ / mo": "$0", "Logs $ / GB": "$0.25", "Free Tier": "3 GB / day", "Per-Host Pricing": "No", Website: "betterstack.com/pricing" },
      { Vendor: "Sentry", "Starter $ / mo": "$26", "Logs $ / GB": "—", "Free Tier": "5K errors + 10K perf / mo", "Per-Host Pricing": "No", Website: "sentry.io/pricing" },
      { Vendor: "Splunk Observability", "Starter $ / mo": "$15", "Logs $ / GB": "$2.00", "Free Tier": "14-day trial", "Per-Host Pricing": "Yes", Website: "splunk.com/observability" },
      { Vendor: "Highlight.io", "Starter $ / mo": "$0", "Logs $ / GB": "$0.50", "Free Tier": "500 sessions / month", "Per-Host Pricing": "No", Website: "highlight.io/pricing" },
    ],
  },
];

/**
 * Validate that no two PUBLIC_DATASETS entries share a seedKey. This is a
 * programming error (would silently insert only the first); failing loud
 * at function entry is cheaper than debugging a missing dataset later.
 */
function assertUniqueSeedKeys(defs: PublicDatasetDef[]): void {
  const seen = new Set<string>();
  for (const ds of defs) {
    if (seen.has(ds.seedKey)) {
      throw new Error(
        `[publicSeed] duplicate seedKey '${ds.seedKey}' in PUBLIC_DATASETS — fix the array`,
      );
    }
    seen.add(ds.seedKey);
  }
}

/**
 * Idempotent loader for curated public datasets.
 *
 *   npx convex run publicSeed:seedPublicDatasets
 *     → inserts missing datasets; backfills seedKey on legacy rows;
 *       skips datasets that are already current
 *
 *   npx convex run publicSeed:seedPublicDatasets '{"force":true}'
 *     → ALSO updates existing curated datasets in place: patches metadata
 *       (name, description, refreshCadence, columns) and replaces all their rows
 *       with the current PUBLIC_DATASETS content. Use this when you've
 *       edited curated content and want it reflected live.
 *
 * Behavior with force=true is destructive at the row level: every row
 * belonging to a curated dataset is deleted and re-inserted from the
 * source. Row IDs change. Acceptable for curated content (no user data).
 */
export const seedPublicDatasets = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    assertUniqueSeedKeys(PUBLIC_DATASETS);
    const now = Date.now();

    const existing = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", SYSTEM_OWNER_ID))
      .collect();

    const byKey = new Map(
      existing.filter((d) => d.seedKey).map((d) => [d.seedKey as string, d]),
    );
    const byName = new Map(
      existing.filter((d) => !d.seedKey).map((d) => [d.name, d]),
    );

    let inserted = 0;
    let updated = 0;
    let backfilled = 0;
    let skipped = 0;

    for (const ds of PUBLIC_DATASETS) {
      const tracked = byKey.get(ds.seedKey);

      if (tracked) {
        if (!force) {
          skipped++;
          continue;
        }

        // Force-update: patch metadata + replace rows. Reset rowCount
        // alongside the row replacement so the dashboard reflects the
        // curated content immediately. We know the exact post-state
        // (`ds.rows.length`), so no recount needed.
        await ctx.db.patch(tracked._id, {
          name: ds.name,
          description: ds.description,
          refreshCadence: ds.refreshCadence,
          refreshEnabled: ds.refreshCadence !== "manual",
          nextRefreshAt: nextRefreshAtFor(ds.refreshCadence, now),
          columns: ds.columns,
          status: "live",
          visibility: "public",
          rowCount: ds.rows.length,
        });

        const oldRows = await ctx.db
          .query("datasetRows")
          .withIndex("by_dataset", (q) => q.eq("datasetId", tracked._id))
          .collect();
        for (const r of oldRows) {
          await ctx.db.delete(r._id);
        }
        for (const row of ds.rows) {
          await ctx.db.insert("datasetRows", {
            datasetId: tracked._id,
            data: row,
          });
        }
        updated++;
        continue;
      }

      // Legacy row exists with this name but no seedKey → adopt the key
      // (one-time migration). Subsequent runs hit byKey instead.
      const legacy = byName.get(ds.name);
      if (legacy) {
        await ctx.db.patch(legacy._id, {
          seedKey: ds.seedKey,
          refreshCadence: ds.refreshCadence,
          refreshEnabled: ds.refreshCadence !== "manual",
          nextRefreshAt: nextRefreshAtFor(ds.refreshCadence, now),
          visibility: "public",
        });
        backfilled++;
        continue;
      }

      const datasetId = await ctx.db.insert("datasets", {
        seedKey: ds.seedKey,
        name: ds.name,
        description: ds.description,
        ownerId: SYSTEM_OWNER_ID,
        status: "live",
        refreshCadence: ds.refreshCadence,
        refreshEnabled: ds.refreshCadence !== "manual",
        nextRefreshAt: nextRefreshAtFor(ds.refreshCadence, now),
        visibility: "public",
        columns: ds.columns,
        rowCount: ds.rows.length,
      });

      for (const row of ds.rows) {
        await ctx.db.insert("datasetRows", {
          datasetId,
          data: row,
        });
      }
      inserted++;
    }

    return {
      inserted,
      updated,
      backfilled,
      skipped,
      total: PUBLIC_DATASETS.length,
    };
  },
});
