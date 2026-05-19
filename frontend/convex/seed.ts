import { mutation } from "./_generated/server";

type ColType = "text" | "number" | "boolean" | "url" | "date";

interface DatasetDef {
  name: string;
  description: string;
  status: "live" | "paused" | "building";
  cadence: string;
  columns: { name: string; type: ColType; description?: string }[];
  rows: Record<string, string>[];
}

const SEED_DATASETS: DatasetDef[] = [
  {
    name: "YC S25 Companies Hiring",
    description:
      "Active YC S25 companies with open engineering roles, tracking headcount and positions across career pages.",
    status: "live",
    cadence: "Every 6 hours",
    columns: [
      { name: "Company", type: "text" },
      { name: "Description", type: "text" },
      { name: "Website", type: "url" },
      { name: "Hiring", type: "boolean" },
      { name: "Open Roles", type: "number" },
      { name: "Stage", type: "text" },
      { name: "Location", type: "text" },
      { name: "Founded", type: "date" },
      { name: "Employees", type: "number" },
      { name: "LinkedIn", type: "url" },
    ],
    rows: [
      { Company: "Airbase", Description: "Spend management platform for mid-market...", Website: "airbase.com", Hiring: "Yes", "Open Roles": "12", Stage: "Series B", Location: "San Francisco", Founded: "2017", Employees: "250", LinkedIn: "linkedin.com/company/airbase" },
      { Company: "Brex", Description: "Financial OS for growing companies built...", Website: "brex.com", Hiring: "Yes", "Open Roles": "34", Stage: "Series D", Location: "New York", Founded: "2017", Employees: "1200", LinkedIn: "linkedin.com/company/brex" },
      { Company: "Clerk", Description: "Authentication and user management for...", Website: "clerk.com", Hiring: "Yes", "Open Roles": "8", Stage: "Series A", Location: "San Francisco", Founded: "2019", Employees: "85", LinkedIn: "linkedin.com/company/clerk-dev" },
      { Company: "Deel", Description: "Global payroll and compliance platform...", Website: "deel.com", Hiring: "Yes", "Open Roles": "21", Stage: "Series D", Location: "Remote", Founded: "2019", Employees: "3000", LinkedIn: "linkedin.com/company/deel" },
      { Company: "Expo", Description: "Framework and platform for universal React...", Website: "expo.dev", Hiring: "No", "Open Roles": "0", Stage: "Series B", Location: "Palo Alto", Founded: "2014", Employees: "60", LinkedIn: "linkedin.com/company/expo-dev" },
      { Company: "Fly.io", Description: "Deploy app servers close to users with a...", Website: "fly.io", Hiring: "Yes", "Open Roles": "5", Stage: "Series C", Location: "Chicago", Founded: "2017", Employees: "120", LinkedIn: "linkedin.com/company/fly-io" },
      { Company: "Graphite", Description: "Modern code review tool that stacks pull...", Website: "graphite.dev", Hiring: "Yes", "Open Roles": "4", Stage: "Series A", Location: "New York", Founded: "2020", Employees: "35", LinkedIn: "linkedin.com/company/graphitedev" },
      { Company: "Helicone", Description: "Open-source LLM observability platform...", Website: "helicone.ai", Hiring: "Yes", "Open Roles": "6", Stage: "Seed", Location: "San Francisco", Founded: "2023", Employees: "15", LinkedIn: "linkedin.com/company/helicone" },
      { Company: "Incident.io", Description: "Incident management platform that helps...", Website: "incident.io", Hiring: "Yes", "Open Roles": "11", Stage: "Series B", Location: "London", Founded: "2021", Employees: "130", LinkedIn: "linkedin.com/company/incident-io" },
      { Company: "Jasper", Description: "AI copilot for enterprise marketing teams...", Website: "jasper.ai", Hiring: "No", "Open Roles": "0", Stage: "Series A", Location: "Austin", Founded: "2021", Employees: "400", LinkedIn: "linkedin.com/company/jasper-ai" },
      { Company: "Knock", Description: "Notification infrastructure for developers...", Website: "knock.app", Hiring: "Yes", "Open Roles": "3", Stage: "Series A", Location: "New York", Founded: "2020", Employees: "30", LinkedIn: "linkedin.com/company/knocklabs" },
      { Company: "LangChain", Description: "Framework for developing applications...", Website: "langchain.com", Hiring: "Yes", "Open Roles": "9", Stage: "Series A", Location: "San Francisco", Founded: "2022", Employees: "60", LinkedIn: "linkedin.com/company/langchain" },
      { Company: "Mintlify", Description: "Modern documentation platform that makes...", Website: "mintlify.com", Hiring: "Yes", "Open Roles": "7", Stage: "Series A", Location: "San Francisco", Founded: "2021", Employees: "40", LinkedIn: "linkedin.com/company/mintlify" },
      { Company: "Neon", Description: "Serverless Postgres with branching and...", Website: "neon.tech", Hiring: "Yes", "Open Roles": "15", Stage: "Series B", Location: "San Francisco", Founded: "2021", Employees: "150", LinkedIn: "linkedin.com/company/neondatabase" },
      { Company: "OpenPipe", Description: "Fine-tuning platform that turns LLM logs...", Website: "openpipe.ai", Hiring: "Yes", "Open Roles": "4", Stage: "Seed", Location: "San Francisco", Founded: "2023", Employees: "12", LinkedIn: "linkedin.com/company/openpipe" },
      { Company: "Posthog", Description: "Open-source product analytics platform...", Website: "posthog.com", Hiring: "Yes", "Open Roles": "8", Stage: "Series B", Location: "Remote", Founded: "2020", Employees: "50", LinkedIn: "linkedin.com/company/posthog" },
      { Company: "Resend", Description: "Email API for developers with React Email...", Website: "resend.com", Hiring: "Yes", "Open Roles": "6", Stage: "Series A", Location: "San Francisco", Founded: "2022", Employees: "25", LinkedIn: "linkedin.com/company/resend" },
      { Company: "Supabase", Description: "Open-source Firebase alternative with...", Website: "supabase.com", Hiring: "Yes", "Open Roles": "18", Stage: "Series C", Location: "Remote", Founded: "2020", Employees: "200", LinkedIn: "linkedin.com/company/supabase" },
      { Company: "Trigger.dev", Description: "Background jobs framework for TypeScript...", Website: "trigger.dev", Hiring: "Yes", "Open Roles": "3", Stage: "Seed", Location: "London", Founded: "2022", Employees: "15", LinkedIn: "linkedin.com/company/triggerdev" },
      { Company: "Unkey", Description: "API authentication and rate limiting built...", Website: "unkey.dev", Hiring: "Yes", "Open Roles": "2", Stage: "Seed", Location: "Remote", Founded: "2023", Employees: "8", LinkedIn: "linkedin.com/company/unkey" },
    ],
  },
  {
    name: "Bay Area Vehicle Insurance Quotes",
    description:
      "Monthly premium quotes for a 2020 Honda Civic across major insurers in the Bay Area.",
    status: "live",
    cadence: "Daily",
    columns: [
      { name: "Provider", type: "text" },
      { name: "Description", type: "text" },
      { name: "Website", type: "url" },
      { name: "Monthly Premium", type: "number" },
      { name: "Deductible", type: "number" },
      { name: "Coverage Type", type: "text" },
      { name: "AM Best Rating", type: "text" },
      { name: "Customer Rating", type: "number" },
      { name: "Quote Date", type: "date" },
    ],
    rows: [
      { Provider: "Geico", Description: "Government Employees Insurance Company...", Website: "geico.com", "Monthly Premium": "$142", Deductible: "$500", "Coverage Type": "Full Coverage", "AM Best Rating": "A++", "Customer Rating": "4.2", "Quote Date": "May 17" },
      { Provider: "State Farm", Description: "Largest property and casualty insurance...", Website: "statefarm.com", "Monthly Premium": "$158", Deductible: "$500", "Coverage Type": "Full Coverage", "AM Best Rating": "A++", "Customer Rating": "4.5", "Quote Date": "May 17" },
      { Provider: "Progressive", Description: "American insurance company, third largest...", Website: "progressive.com", "Monthly Premium": "$131", Deductible: "$750", "Coverage Type": "Basic", "AM Best Rating": "A+", "Customer Rating": "3.9", "Quote Date": "May 17" },
      { Provider: "Allstate", Description: "Second largest personal lines insurer in...", Website: "allstate.com", "Monthly Premium": "$167", Deductible: "$500", "Coverage Type": "Full Coverage", "AM Best Rating": "A+", "Customer Rating": "4.1", "Quote Date": "May 17" },
      { Provider: "USAA", Description: "Financial services for military members...", Website: "usaa.com", "Monthly Premium": "$119", Deductible: "$500", "Coverage Type": "Full Coverage", "AM Best Rating": "A++", "Customer Rating": "4.8", "Quote Date": "May 17" },
      { Provider: "Liberty Mutual", Description: "American diversified global insurer...", Website: "libertymutual.com", "Monthly Premium": "$172", Deductible: "$500", "Coverage Type": "Full Coverage", "AM Best Rating": "A", "Customer Rating": "3.8", "Quote Date": "May 17" },
      { Provider: "Farmers", Description: "American insurer group of automobiles...", Website: "farmers.com", "Monthly Premium": "$155", Deductible: "$750", "Coverage Type": "Full Coverage", "AM Best Rating": "A", "Customer Rating": "4.0", "Quote Date": "May 17" },
      { Provider: "Nationwide", Description: "Insurance and financial services company...", Website: "nationwide.com", "Monthly Premium": "$148", Deductible: "$500", "Coverage Type": "Full Coverage", "AM Best Rating": "A+", "Customer Rating": "4.3", "Quote Date": "May 17" },
    ],
  },
  {
    name: "Competitor Blog Posts",
    description:
      "Latest blog posts from competitor companies, tracking publish date, title, and topic tags.",
    status: "live",
    cadence: "Every 12 hours",
    columns: [
      { name: "Company", type: "text" },
      { name: "Title", type: "text" },
      { name: "URL", type: "url" },
      { name: "Date", type: "date" },
      { name: "Topic", type: "text" },
      { name: "Author", type: "text" },
      { name: "Read Time", type: "text" },
    ],
    rows: [
      { Company: "Firecrawl", Title: "Announcing v2 API with Structured Extraction", URL: "firecrawl.dev/blog/v2-api", Date: "May 16", Topic: "Product", Author: "Mendable Team", "Read Time": "5 min" },
      { Company: "Apify", Title: "The Complete Web Scraping Guide for 2026", URL: "blog.apify.com/scraping-guide", Date: "May 15", Topic: "Tutorial", Author: "Ondra Urban", "Read Time": "12 min" },
      { Company: "Browserbase", Title: "Introducing Stealth Mode for Anti-Detection", URL: "browserbase.com/blog/stealth", Date: "May 14", Topic: "Feature", Author: "Paul Klein", "Read Time": "4 min" },
      { Company: "ScrapFly", Title: "Understanding Proxy Networks: A Deep Dive", URL: "scrapfly.io/blog/proxy-networks", Date: "May 13", Topic: "Guide", Author: "ScrapFly Team", "Read Time": "8 min" },
      { Company: "Bright Data", Title: "AI-Powered Data Collection at Scale", URL: "brightdata.com/blog/ai-collection", Date: "May 12", Topic: "Research", Author: "Or Lenchner", "Read Time": "6 min" },
      { Company: "Crawlee", Title: "How We Rebuilt Our Crawler from Scratch", URL: "crawlee.dev/blog/rebuild", Date: "May 11", Topic: "Engineering", Author: "Jan Curn", "Read Time": "10 min" },
      { Company: "Zyte", Title: "E-commerce Price Monitoring Best Practices", URL: "zyte.com/blog/price-monitoring", Date: "May 10", Topic: "Guide", Author: "Zyte Team", "Read Time": "7 min" },
      { Company: "Playwright", Title: "New Locator Strategies in v1.45", URL: "playwright.dev/blog/v145", Date: "May 9", Topic: "Release", Author: "MS Team", "Read Time": "3 min" },
    ],
  },
  {
    name: "GPU Prices — RTX 5090",
    description:
      "Price tracking for NVIDIA RTX 5090 across major retailers, including stock availability.",
    status: "live",
    cadence: "Every 30 min",
    columns: [
      { name: "Retailer", type: "text" },
      { name: "Product Name", type: "text" },
      { name: "Price", type: "number" },
      { name: "In Stock", type: "boolean" },
      { name: "Shipping", type: "text" },
      { name: "Seller Type", type: "text" },
      { name: "URL", type: "url" },
      { name: "Last Checked", type: "date" },
    ],
    rows: [
      { Retailer: "Newegg", "Product Name": "NVIDIA GeForce RTX 5090 Founders Edition", Price: "$1,999", "In Stock": "Yes", Shipping: "Free 2-day", "Seller Type": "Direct", URL: "newegg.com/nvidia-rtx-5090", "Last Checked": "12 min ago" },
      { Retailer: "Best Buy", "Product Name": "NVIDIA GeForce RTX 5090 FE 32GB GDDR7", Price: "$1,999", "In Stock": "No", Shipping: "—", "Seller Type": "Direct", URL: "bestbuy.com/nvidia-rtx-5090", "Last Checked": "12 min ago" },
      { Retailer: "Amazon", "Product Name": "NVIDIA RTX 5090 Founders Edition 32GB", Price: "$2,149", "In Stock": "Yes", Shipping: "$12.99", "Seller Type": "3rd Party", URL: "amazon.com/dp/B0DRTX5090", "Last Checked": "12 min ago" },
      { Retailer: "B&H Photo", "Product Name": "NVIDIA GeForce RTX 5090 FE 32GB", Price: "$1,999", "In Stock": "Yes", Shipping: "Free Expedited", "Seller Type": "Direct", URL: "bhphoto.com/nvidia-rtx-5090", "Last Checked": "12 min ago" },
      { Retailer: "Micro Center", "Product Name": "NVIDIA GeForce RTX 5090 Founders 32GB", Price: "$1,979", "In Stock": "Yes", Shipping: "In-store only", "Seller Type": "Direct", URL: "microcenter.com/rtx-5090", "Last Checked": "12 min ago" },
      { Retailer: "CDW", "Product Name": "NVIDIA RTX 5090 FE 32GB Graphics Card", Price: "$2,049", "In Stock": "Yes", Shipping: "$19.99", "Seller Type": "Direct", URL: "cdw.com/nvidia-rtx-5090", "Last Checked": "12 min ago" },
    ],
  },
  {
    name: "SG Startup Funding Rounds",
    description:
      "Recent funding rounds for Singapore-based startups, sourced from press releases and Crunchbase.",
    status: "building",
    cadence: "Daily",
    columns: [
      { name: "Startup", type: "text" },
      { name: "Description", type: "text" },
      { name: "Round", type: "text" },
      { name: "Amount", type: "number" },
      { name: "Lead Investor", type: "text" },
      { name: "Date", type: "date" },
      { name: "Sector", type: "text" },
      { name: "Valuation", type: "number" },
      { name: "Crunchbase", type: "url" },
    ],
    rows: [
      { Startup: "Grab", Description: "Southeast Asian super app for ride-hailing...", Round: "Series H", Amount: "$300M", "Lead Investor": "GIC", Date: "May 10", Sector: "Transportation", Valuation: "$14B", Crunchbase: "crunchbase.com/organization/grab" },
      { Startup: "Carousell", Description: "Consumer-to-consumer marketplace for...", Round: "Series D", Amount: "$100M", "Lead Investor": "Temasek", Date: "May 8", Sector: "Marketplace", Valuation: "$1.1B", Crunchbase: "crunchbase.com/organization/carousell" },
      { Startup: "Ninja Van", Description: "Logistics company providing last-mile...", Round: "Series E", Amount: "$150M", "Lead Investor": "B Capital", Date: "May 5", Sector: "Logistics", Valuation: "$2B", Crunchbase: "crunchbase.com/organization/ninjavan" },
      { Startup: "PatSnap", Description: "AI-powered innovation intelligence...", Round: "Series D", Amount: "$90M", "Lead Investor": "SoftBank", Date: "May 2", Sector: "Enterprise", Valuation: "$1B", Crunchbase: "crunchbase.com/organization/patsnap" },
      { Startup: "Endowus", Description: "Digital wealth platform for personal...", Round: "Series B", Amount: "$45M", "Lead Investor": "UBS", Date: "Apr 28", Sector: "Fintech", Valuation: "$400M", Crunchbase: "crunchbase.com/organization/endowus" },
      { Startup: "Nium", Description: "Global payments infrastructure platform...", Round: "Series D", Amount: "$200M", "Lead Investor": "Visa", Date: "Apr 20", Sector: "Fintech", Valuation: "$2.1B", Crunchbase: "crunchbase.com/organization/nium" },
    ],
  },
];

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const ownerId = identity.subject;

    const existing = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .first();
    if (existing) return { status: "already_seeded" };

    for (const ds of SEED_DATASETS) {
      const datasetId = await ctx.db.insert("datasets", {
        name: ds.name,
        description: ds.description,
        ownerId,
        status: ds.status,
        cadence: ds.cadence,
        columns: ds.columns,
      });

      for (const row of ds.rows) {
        await ctx.db.insert("datasetRows", {
          datasetId,
          data: row,
        });
      }
    }

    return { status: "seeded", count: SEED_DATASETS.length };
  },
});
