export type DatasetStatus = "live" | "paused" | "building";

export type ColumnType = "text" | "number" | "boolean" | "url" | "date";

export interface Column {
  name: string;
  type: ColumnType;
}

export interface MockDataset {
  id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  cadence: string;
  lastUpdated: string;
  columns: Column[];
  rows: string[][];
}

export const MOCK_DATASETS: MockDataset[] = [
  {
    id: "ds_1",
    name: "YC S25 Companies Hiring",
    description:
      "Active YC S25 companies with open engineering roles, tracking headcount and positions across career pages.",
    status: "live",
    cadence: "Every 6 hours",
    lastUpdated: "5 min ago",
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
      ["Airbase", "Spend management platform for mid-market...", "airbase.com", "Yes", "12", "Series B", "San Francisco", "2017", "250", "linkedin.com/company/airbase"],
      ["Brex", "Financial OS for growing companies built...", "brex.com", "Yes", "34", "Series D", "New York", "2017", "1200", "linkedin.com/company/brex"],
      ["Clerk", "Authentication and user management for...", "clerk.com", "Yes", "8", "Series A", "San Francisco", "2019", "85", "linkedin.com/company/clerk-dev"],
      ["Deel", "Global payroll and compliance platform...", "deel.com", "Yes", "21", "Series D", "Remote", "2019", "3000", "linkedin.com/company/deel"],
      ["Expo", "Framework and platform for universal React...", "expo.dev", "No", "0", "Series B", "Palo Alto", "2014", "60", "linkedin.com/company/expo-dev"],
      ["Fly.io", "Deploy app servers close to users with a...", "fly.io", "Yes", "5", "Series C", "Chicago", "2017", "120", "linkedin.com/company/fly-io"],
      ["Graphite", "Modern code review tool that stacks pull...", "graphite.dev", "Yes", "4", "Series A", "New York", "2020", "35", "linkedin.com/company/graphitedev"],
      ["Helicone", "Open-source LLM observability platform...", "helicone.ai", "Yes", "6", "Seed", "San Francisco", "2023", "15", "linkedin.com/company/helicone"],
      ["Incident.io", "Incident management platform that helps...", "incident.io", "Yes", "11", "Series B", "London", "2021", "130", "linkedin.com/company/incident-io"],
      ["Jasper", "AI copilot for enterprise marketing teams...", "jasper.ai", "No", "0", "Series A", "Austin", "2021", "400", "linkedin.com/company/jasper-ai"],
      ["Knock", "Notification infrastructure for developers...", "knock.app", "Yes", "3", "Series A", "New York", "2020", "30", "linkedin.com/company/knocklabs"],
      ["LangChain", "Framework for developing applications...", "langchain.com", "Yes", "9", "Series A", "San Francisco", "2022", "60", "linkedin.com/company/langchain"],
      ["Mintlify", "Modern documentation platform that makes...", "mintlify.com", "Yes", "7", "Series A", "San Francisco", "2021", "40", "linkedin.com/company/mintlify"],
      ["Neon", "Serverless Postgres with branching and...", "neon.tech", "Yes", "15", "Series B", "San Francisco", "2021", "150", "linkedin.com/company/neondatabase"],
      ["OpenPipe", "Fine-tuning platform that turns LLM logs...", "openpipe.ai", "Yes", "4", "Seed", "San Francisco", "2023", "12", "linkedin.com/company/openpipe"],
      ["Posthog", "Open-source product analytics platform...", "posthog.com", "Yes", "8", "Series B", "Remote", "2020", "50", "linkedin.com/company/posthog"],
      ["Resend", "Email API for developers with React Email...", "resend.com", "Yes", "6", "Series A", "San Francisco", "2022", "25", "linkedin.com/company/resend"],
      ["Supabase", "Open-source Firebase alternative with...", "supabase.com", "Yes", "18", "Series C", "Remote", "2020", "200", "linkedin.com/company/supabase"],
      ["Trigger.dev", "Background jobs framework for TypeScript...", "trigger.dev", "Yes", "3", "Seed", "London", "2022", "15", "linkedin.com/company/triggerdev"],
      ["Unkey", "API authentication and rate limiting built...", "unkey.dev", "Yes", "2", "Seed", "Remote", "2023", "8", "linkedin.com/company/unkey"],
    ],
  },
  {
    id: "ds_2",
    name: "Bay Area Vehicle Insurance Quotes",
    description:
      "Monthly premium quotes for a 2020 Honda Civic across major insurers in the Bay Area.",
    status: "live",
    cadence: "Daily",
    lastUpdated: "2 hours ago",
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
      ["Geico", "Government Employees Insurance Company...", "geico.com", "$142", "$500", "Full Coverage", "A++", "4.2", "May 17"],
      ["State Farm", "Largest property and casualty insurance...", "statefarm.com", "$158", "$500", "Full Coverage", "A++", "4.5", "May 17"],
      ["Progressive", "American insurance company, third largest...", "progressive.com", "$131", "$750", "Basic", "A+", "3.9", "May 17"],
      ["Allstate", "Second largest personal lines insurer in...", "allstate.com", "$167", "$500", "Full Coverage", "A+", "4.1", "May 17"],
      ["USAA", "Financial services for military members...", "usaa.com", "$119", "$500", "Full Coverage", "A++", "4.8", "May 17"],
      ["Liberty Mutual", "American diversified global insurer...", "libertymutual.com", "$172", "$500", "Full Coverage", "A", "3.8", "May 17"],
      ["Farmers", "American insurer group of automobiles...", "farmers.com", "$155", "$750", "Full Coverage", "A", "4.0", "May 17"],
      ["Nationwide", "Insurance and financial services company...", "nationwide.com", "$148", "$500", "Full Coverage", "A+", "4.3", "May 17"],
      ["AAA", "Federation of motor clubs providing...", "aaa.com", "$136", "$500", "Full Coverage", "A", "4.4", "May 17"],
      ["Mercury", "California-based automobile insurance...", "mercuryinsurance.com", "$124", "$750", "Basic", "A", "3.7", "May 17"],
      ["Wawanesa", "Canadian mutual insurance company with...", "wawanesa.com", "$128", "$500", "Full Coverage", "A", "4.1", "May 17"],
      ["Kemper", "Diversified insurance holding company...", "kemper.com", "$163", "$1000", "Basic", "A-", "3.5", "May 17"],
    ],
  },
  {
    id: "ds_3",
    name: "Competitor Blog Posts",
    description:
      "Latest blog posts from competitor companies, tracking publish date, title, and topic tags.",
    status: "live",
    cadence: "Every 12 hours",
    lastUpdated: "1 hour ago",
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
      ["Firecrawl", "Announcing v2 API with Structured Extraction", "firecrawl.dev/blog/v2-api", "May 16", "Product", "Mendable Team", "5 min"],
      ["Apify", "The Complete Web Scraping Guide for 2026", "blog.apify.com/scraping-guide", "May 15", "Tutorial", "Ondra Urban", "12 min"],
      ["Browserbase", "Introducing Stealth Mode for Anti-Detection", "browserbase.com/blog/stealth", "May 14", "Feature", "Paul Klein", "4 min"],
      ["ScrapFly", "Understanding Proxy Networks: A Deep Dive", "scrapfly.io/blog/proxy-networks", "May 13", "Guide", "ScrapFly Team", "8 min"],
      ["Bright Data", "AI-Powered Data Collection at Scale", "brightdata.com/blog/ai-collection", "May 12", "Research", "Or Lenchner", "6 min"],
      ["Crawlee", "How We Rebuilt Our Crawler from Scratch", "crawlee.dev/blog/rebuild", "May 11", "Engineering", "Jan Curn", "10 min"],
      ["Zyte", "E-commerce Price Monitoring Best Practices", "zyte.com/blog/price-monitoring", "May 10", "Guide", "Zyte Team", "7 min"],
      ["Playwright", "New Locator Strategies in v1.45", "playwright.dev/blog/v145", "May 9", "Release", "MS Team", "3 min"],
      ["Puppeteer", "Chrome DevTools Protocol Changes in 2026", "pptr.dev/blog/cdp-2026", "May 8", "Technical", "Google Team", "6 min"],
      ["ScrapeOps", "Rotating Proxies vs Residential: Benchmarks", "scrapeops.io/blog/proxy-bench", "May 7", "Benchmark", "Harry L.", "9 min"],
    ],
  },
  {
    id: "ds_4",
    name: "Menlo Park Restaurants — Coca-Cola",
    description:
      "Restaurants in Menlo Park that serve Coca-Cola products, with menu prices and locations.",
    status: "paused",
    cadence: "Weekly",
    lastUpdated: "3 days ago",
    columns: [
      { name: "Restaurant", type: "text" },
      { name: "Cuisine", type: "text" },
      { name: "Address", type: "text" },
      { name: "Coke Price", type: "number" },
      { name: "Diet Coke", type: "boolean" },
      { name: "Sprite", type: "boolean" },
      { name: "Rating", type: "number" },
      { name: "Reviews", type: "number" },
      { name: "Website", type: "url" },
    ],
    rows: [
      ["Cafe Borrone", "Cafe & Bakery", "1010 El Camino Real", "$3.50", "Yes", "Yes", "4.6", "1,240", "cafeborrone.com"],
      ["Gravity", "Bar & Grill", "888 Villa St", "$4.00", "Yes", "Yes", "4.3", "890", "—"],
      ["Mendocino Farms", "Farm-to-table", "703 El Camino Real", "$3.75", "Yes", "No", "4.5", "2,100", "mendocinofarms.com"],
      ["Left Bank Brasserie", "French", "635 Santa Cruz Ave", "$4.25", "Yes", "Yes", "4.2", "1,650", "leftbank.com"],
      ["Starbelly", "American", "498 Oak Grove Ave", "$3.50", "No", "Yes", "4.0", "720", "—"],
      ["Fey Restaurant", "Asian Fusion", "140 University Ave", "$3.75", "Yes", "Yes", "4.4", "510", "feyrestaurant.com"],
      ["Harvest Bowl", "Health Food", "1025 El Camino Real", "$3.25", "Yes", "No", "4.1", "330", "harvestbowl.com"],
      ["Pizza My Heart", "Pizza", "800 Santa Cruz Ave", "$2.99", "Yes", "Yes", "4.3", "1,100", "pizzamyheart.com"],
    ],
  },
  {
    id: "ds_5",
    name: "GPU Prices — RTX 5090",
    description:
      "Price tracking for NVIDIA RTX 5090 across major retailers, including stock availability.",
    status: "live",
    cadence: "Every 30 min",
    lastUpdated: "12 min ago",
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
      ["Newegg", "NVIDIA GeForce RTX 5090 Founders Edition", "$1,999", "Yes", "Free 2-day", "Direct", "newegg.com/nvidia-rtx-5090", "12 min ago"],
      ["Best Buy", "NVIDIA GeForce RTX 5090 FE 32GB GDDR7", "$1,999", "No", "—", "Direct", "bestbuy.com/nvidia-rtx-5090", "12 min ago"],
      ["Amazon", "NVIDIA RTX 5090 Founders Edition 32GB", "$2,149", "Yes", "$12.99", "3rd Party", "amazon.com/dp/B0DRTX5090", "12 min ago"],
      ["B&H Photo", "NVIDIA GeForce RTX 5090 FE 32GB", "$1,999", "Yes", "Free Expedited", "Direct", "bhphoto.com/nvidia-rtx-5090", "12 min ago"],
      ["Micro Center", "NVIDIA GeForce RTX 5090 Founders 32GB", "$1,979", "Yes", "In-store only", "Direct", "microcenter.com/rtx-5090", "12 min ago"],
      ["Adorama", "NVIDIA RTX 5090 Founders Edition GPU", "$1,999", "No", "—", "Direct", "adorama.com/nvidia-rtx-5090", "12 min ago"],
      ["CDW", "NVIDIA RTX 5090 FE 32GB Graphics Card", "$2,049", "Yes", "$19.99", "Direct", "cdw.com/nvidia-rtx-5090", "12 min ago"],
      ["EVGA Store", "NVIDIA RTX 5090 FE 32GB Bundle", "$2,099", "Yes", "Free", "Direct", "evga.com/rtx-5090", "12 min ago"],
    ],
  },
  {
    id: "ds_6",
    name: "SG Startup Funding Rounds",
    description:
      "Recent funding rounds for Singapore-based startups, sourced from press releases and Crunchbase.",
    status: "building",
    cadence: "Daily",
    lastUpdated: "Just now",
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
      ["Grab", "Southeast Asian super app for ride-hailing...", "Series H", "$300M", "GIC", "May 10", "Transportation", "$14B", "crunchbase.com/organization/grab"],
      ["Carousell", "Consumer-to-consumer marketplace for...", "Series D", "$100M", "Temasek", "May 8", "Marketplace", "$1.1B", "crunchbase.com/organization/carousell"],
      ["Ninja Van", "Logistics company providing last-mile...", "Series E", "$150M", "B Capital", "May 5", "Logistics", "$2B", "crunchbase.com/organization/ninjavan"],
      ["PatSnap", "AI-powered innovation intelligence...", "Series D", "$90M", "SoftBank", "May 2", "Enterprise", "$1B", "crunchbase.com/organization/patsnap"],
      ["Endowus", "Digital wealth platform for personal...", "Series B", "$45M", "UBS", "Apr 28", "Fintech", "$400M", "crunchbase.com/organization/endowus"],
      ["Carro", "Automotive marketplace integrating AI...", "Series C", "$80M", "Sequoia SEA", "Apr 25", "Automotive", "$1.3B", "crunchbase.com/organization/carro"],
      ["Nium", "Global payments infrastructure platform...", "Series D", "$200M", "Visa", "Apr 20", "Fintech", "$2.1B", "crunchbase.com/organization/nium"],
      ["Funding Societies", "SME digital lending platform for...", "Series C", "$60M", "SoftBank", "Apr 18", "Fintech", "$500M", "crunchbase.com/organization/fundingsocieties"],
    ],
  },
];

export function getDataset(id: string): MockDataset | undefined {
  return MOCK_DATASETS.find((ds) => ds.id === id);
}
