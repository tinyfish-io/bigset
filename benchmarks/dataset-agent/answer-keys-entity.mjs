const verifiedAt = "2026-05-20";

export const entityAnswerKeysByPromptId = {
  "latest-ai-blog-posts": {
    verifiedAt,
    sourceUrls: [
      "https://openai.com/index/advancing-content-provenance/",
      "https://www.anthropic.com/news/anthropic-kpmg",
      "https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/",
    ],
    scoringNotes:
      "Latest-post titles drift. Score entity coverage, official domains, dated titles, and source URLs rather than one frozen title only.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "latest_post_title", "latest_post_date", "source_url"],
    expectedEntities: [
      {
        id: "openai",
        label: "OpenAI",
        aliases: ["openai"],
        allowedSourceDomains: ["openai.com"],
        requiredText: ["2026"],
      },
      {
        id: "anthropic",
        label: "Anthropic",
        aliases: ["anthropic"],
        allowedSourceDomains: ["anthropic.com"],
        requiredText: ["2026"],
      },
      {
        id: "google-deepmind",
        label: "Google DeepMind",
        aliases: ["google deepmind", "deepmind"],
        allowedSourceDomains: ["deepmind.google"],
        requiredText: ["2026"],
      },
    ],
    minimumExpectedEntityMatches: 3,
    officialSourceDomains: ["openai.com", "anthropic.com", "deepmind.google"],
  },
  "saas-pricing-pages": {
    verifiedAt: "2026-05-22",
    sourceUrls: [
      "https://stripe.com/pricing",
      "https://www.paddle.com/pricing",
      "https://www.chargebee.com/pricing/",
    ],
    scoringNotes:
      "Pass requires all three vendors, official domains, and visible plan or price text. Paddle's current pricing page can show Checkout transaction pricing.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "pricing_page_url", "plan_or_price", "source_url"],
    expectedEntities: [
      {
        id: "stripe",
        label: "Stripe",
        aliases: ["stripe"],
        allowedSourceDomains: ["stripe.com"],
        requiredText: ["pricing"],
      },
      {
        id: "paddle",
        label: "Paddle",
        aliases: ["paddle"],
        allowedSourceDomains: ["paddle.com"],
        requiredText: ["checkout", "5%", "50"],
      },
      {
        id: "chargebee",
        label: "Chargebee",
        aliases: ["chargebee"],
        allowedSourceDomains: ["chargebee.com"],
        requiredText: ["starter", "performance", "enterprise"],
      },
    ],
    minimumExpectedEntityMatches: 3,
    officialSourceDomains: ["stripe.com", "paddle.com", "chargebee.com"],
  },
  "earnings-release-pages": {
    verifiedAt: "2026-05-22",
    sourceUrls: [
      "https://www.apple.com/newsroom/2026/04/apple-reports-second-quarter-results/",
      "https://www.microsoft.com/en-us/investor/earnings/fy-2026-q3/press-release-webcast",
      "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2027",
    ],
    scoringNotes:
      "As of 2026-05-22, Apple latest verified release is fiscal 2026 Q2 on 2026-04-30, Microsoft is FY26 Q3 on 2026-04-29, and NVIDIA is Q1 fiscal 2027 on 2026-05-20.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "release_date", "fiscal_quarter", "source_url"],
    expectedEntities: [
      {
        id: "apple",
        label: "Apple",
        aliases: ["apple"],
        allowedSourceDomains: ["apple.com"],
        requiredText: ["second quarter", "q2", "2026", "april 30"],
      },
      {
        id: "microsoft",
        label: "Microsoft",
        aliases: ["microsoft"],
        allowedSourceDomains: ["microsoft.com"],
        requiredText: ["fy26 q3", "q3", "april 29", "2026"],
      },
      {
        id: "nvidia",
        label: "NVIDIA",
        aliases: ["nvidia"],
        allowedSourceDomains: ["nvidia.com"],
        requiredText: ["first quarter", "q1", "fiscal 2027", "may 20"],
      },
    ],
    minimumExpectedEntityMatches: 3,
    officialSourceDomains: ["apple.com", "microsoft.com", "nvidia.com"],
  },
  "mcp-docs-pages": {
    verifiedAt,
    sourceUrls: [
      "https://developers.openai.com/api/docs/mcp",
      "https://platform.claude.com/docs/en/agents-and-tools/mcp-connector",
      "https://developers.cloudflare.com/agents/model-context-protocol/",
    ],
    scoringNotes:
      "Pass requires official docs for all three vendors. Blog posts, GitHub examples, and community roundups are not enough.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "docs_title", "docs_url", "summary"],
    expectedEntities: [
      {
        id: "openai",
        label: "OpenAI",
        aliases: ["openai"],
        allowedSourceDomains: ["developers.openai.com", "platform.openai.com", "openai.com"],
        requiredText: ["mcp"],
      },
      {
        id: "anthropic",
        label: "Anthropic",
        aliases: ["anthropic"],
        allowedSourceDomains: ["docs.anthropic.com", "platform.claude.com"],
        requiredText: ["mcp"],
      },
      {
        id: "cloudflare",
        label: "Cloudflare",
        aliases: ["cloudflare"],
        allowedSourceDomains: ["developers.cloudflare.com"],
        requiredText: ["mcp"],
      },
    ],
    minimumExpectedEntityMatches: 3,
    officialSourceDomains: [
      "developers.openai.com",
      "platform.openai.com",
      "openai.com",
      "docs.anthropic.com",
      "platform.claude.com",
      "developers.cloudflare.com",
    ],
  },
  "menlo-park-coca-cola": {
    verifiedAt,
    sourceUrls: [
      "https://order-menlopark.celiasrestaurants.com/",
      "https://www.portablurestaurant.com/menus",
    ],
    scoringNotes:
      "Pass requires direct menu/order evidence for Coke/Coca-Cola. A directory saying a restaurant exists is not proof.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "address", "serves_requested_item", "source_url"],
    rowMustContainAny: ["coca-cola", "coke", "diet coke", "diet coca-cola"],
    minimumScore: 0.7,
  },
  "hcmc-bakery-products": {
    verifiedAt,
    sourceUrls: [
      "https://maisonmarou.com/product/croissant/",
      "https://moncannele.com/products/box-of-9-mini",
    ],
    scoringNotes:
      "Pass requires product-detail URLs from bakery-owned sites, not generic listicles.",
    expectedBehavior: "answer",
    requiredColumns: ["bakery_name", "product_name", "product_url", "source_url"],
    expectedEntities: [
      {
        id: "maison-marou",
        label: "Maison Marou",
        aliases: ["maison marou", "marou"],
        allowedSourceDomains: ["maisonmarou.com"],
        requiredText: ["croissant", "macaron", "opera", "pastry"],
      },
      {
        id: "mon-cannele",
        label: "Mon Cannele",
        aliases: ["mon cannele", "cannel"],
        allowedSourceDomains: ["moncannele.com"],
        requiredText: ["cannel"],
      },
    ],
    minimumExpectedEntityMatches: 1,
    officialSourceDomains: ["maisonmarou.com", "moncannele.com"],
  },
  "ny-ai-startup-careers": {
    verifiedAt,
    sourceUrls: [
      "https://www.runwayml.com/careers",
      "https://www.huggingface.co/jobs",
      "https://www.hebbia.ai/careers",
    ],
    scoringNotes:
      "Pass requires company-owned websites or careers pages. One third-party startup directory with repeated 'View Jobs' text is not enough.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "company_website", "careers_page_url", "is_hiring"],
    expectedEntities: [
      {
        id: "runway",
        label: "Runway",
        aliases: ["runway"],
        allowedSourceDomains: ["runwayml.com"],
        requiredText: ["careers", "jobs"],
      },
      {
        id: "hugging-face",
        label: "Hugging Face",
        aliases: ["hugging face", "huggingface"],
        allowedSourceDomains: ["huggingface.co"],
        requiredText: ["jobs", "careers"],
      },
      {
        id: "hebbia",
        label: "Hebbia",
        aliases: ["hebbia"],
        allowedSourceDomains: ["hebbia.ai"],
        requiredText: ["careers", "jobs"],
      },
    ],
    minimumExpectedEntityMatches: 2,
  },
  "vietnam-fintech-sites": {
    verifiedAt,
    sourceUrls: [
      "https://www.momo.vn/",
      "https://zalopay.vn/",
      "https://vnpay.vn/",
      "https://www.finhay.com.vn/",
    ],
    scoringNotes:
      "Pass requires official company/product domains for Vietnamese fintech examples.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "official_website", "description", "source_url"],
    expectedEntities: [
      {
        id: "momo",
        label: "MoMo",
        aliases: ["momo"],
        allowedSourceDomains: ["momo.vn"],
      },
      {
        id: "zalopay",
        label: "ZaloPay",
        aliases: ["zalopay", "zalo pay"],
        allowedSourceDomains: ["zalopay.vn"],
      },
      {
        id: "vnpay",
        label: "VNPAY",
        aliases: ["vnpay"],
        allowedSourceDomains: ["vnpay.vn"],
      },
      {
        id: "finhay",
        label: "Finhay",
        aliases: ["finhay"],
        allowedSourceDomains: ["finhay.com.vn"],
      },
    ],
    minimumExpectedEntityMatches: 3,
    officialSourceDomains: ["momo.vn", "zalopay.vn", "vnpay.vn", "finhay.com.vn"],
  },
  "district-one-coffee-sites": {
    verifiedAt,
    sourceUrls: ["https://tonkin.coffee/menu/", "https://www.cafehien.com/"],
    scoringNotes:
      "Pass requires a shop-owned site or online menu plus District 1 address evidence.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "website_or_menu_url", "address", "source_url"],
    expectedEntities: [
      {
        id: "tonkin",
        label: "Tonkin Coffee",
        aliases: ["tonkin"],
        allowedSourceDomains: ["tonkin.coffee"],
        requiredText: ["district 1", "menu"],
      },
      {
        id: "hien",
        label: "Hien Cafe",
        aliases: ["hien cafe", "cafe hien"],
        allowedSourceDomains: ["cafehien.com"],
        requiredText: ["menu", "ho chi minh"],
      },
    ],
    minimumExpectedEntityMatches: 1,
  },
  "amazon-starbucks-products": {
    verifiedAt,
    sourceUrls: ["https://www.amazon.com/stores/Starbucks/Starbucks/page/"],
    scoringNotes:
      "Pass requires Amazon product/listing evidence with product name, price, image URL, and stock/availability. If Amazon blocks access, an honest validation issue beats hallucinated products.",
    expectedBehavior: "answer",
    requiredColumns: ["product_name", "price", "image_url", "in_stock"],
    officialSourceDomains: ["amazon.com"],
    rowMustContainAny: ["starbucks"],
    minimumScore: 0.7,
  },
  "california-insurance-prices": {
    verifiedAt,
    sourceUrls: [
      "https://www.geico.com/auto-insurance/",
      "https://www.progressive.com/auto/",
      "https://www.statefarm.com/insurance/auto",
    ],
    scoringNotes:
      "Actual prices require driver, vehicle, ZIP, coverage, and deductible. Best behavior is official quote pages plus missing-input validation, not invented premiums.",
    expectedBehavior: "clarify_or_abstain",
    requiredColumns: ["provider_name", "quote_page_url", "missing_inputs", "source_url"],
    clarificationTerms: ["driver", "vehicle", "zip", "coverage", "deductible"],
    officialSourceDomains: ["geico.com", "progressive.com", "statefarm.com"],
  },
  "la-coke-menu-lol": {
    verifiedAt,
    sourceUrls: [],
    scoringNotes:
      "Pass requires direct LA menu/order evidence for Coke/Coca-Cola. Yelp/listicle rows are not enough.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "menu_url", "serves_requested_item", "source_url"],
    rowMustContainAny: ["coca-cola", "coke", "diet coke", "soft drink"],
    minimumScore: 0.9,
  },
  "sf-ml-hiring-rn": {
    verifiedAt,
    sourceUrls: [
      "https://openai.com/careers/",
      "https://www.anthropic.com/careers",
      "https://www.perplexity.ai/careers",
    ],
    scoringNotes:
      "Pass requires current company-owned careers/job pages with ML or AI role evidence near San Francisco or the Bay Area.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "careers_page_url", "open_role_title", "source_url"],
    expectedEntities: [
      {
        id: "openai",
        label: "OpenAI",
        aliases: ["openai"],
        allowedSourceDomains: ["openai.com"],
        requiredText: ["machine learning", "ml", "research", "engineer"],
      },
      {
        id: "anthropic",
        label: "Anthropic",
        aliases: ["anthropic"],
        allowedSourceDomains: ["anthropic.com"],
        requiredText: ["machine learning", "ml", "research", "engineer"],
      },
      {
        id: "perplexity",
        label: "Perplexity",
        aliases: ["perplexity"],
        allowedSourceDomains: ["perplexity.ai"],
        requiredText: ["machine learning", "ml", "engineer"],
      },
    ],
    minimumExpectedEntityMatches: 1,
  },
  "latest-ai-company-stuff": {
    verifiedAt,
    sourceUrls: [],
    scoringNotes:
      "Prompt is underspecified. Best behavior is ask which companies and item types count, or return an explicitly scoped partial dataset with validation issues.",
    expectedBehavior: "clarify_or_abstain",
    requiredColumns: ["entity_name", "latest_item_title", "latest_item_url", "source_url"],
    clarificationTerms: ["which companies", "source type", "news", "blog", "release", "columns"],
  },
  "pastry-things-menlo": {
    verifiedAt,
    sourceUrls: ["https://mademoisellecolette.com/", "https://www.fleurdelysbakery.com/"],
    scoringNotes:
      "Pass requires bakery-owned websites or product/menu pages near Menlo Park. 'Good' should not become invented ratings.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "product_or_business_name", "website_url", "source_url"],
    expectedEntities: [
      {
        id: "mademoiselle-colette",
        label: "Mademoiselle Colette",
        aliases: ["mademoiselle colette"],
        allowedSourceDomains: ["mademoisellecolette.com"],
      },
      {
        id: "fleur-de-lys",
        label: "Fleur de Lys",
        aliases: ["fleur de lys"],
        allowedSourceDomains: ["fleurdelysbakery.com"],
      },
    ],
    minimumExpectedEntityMatches: 1,
  },
  "perplexity-like-companies": {
    verifiedAt,
    sourceUrls: ["https://www.perplexity.ai/", "https://you.com/", "https://www.glean.com/"],
    scoringNotes:
      "Prompt is vague but answerable as AI search/answer companies if the system explains the comparison. Pass requires official websites and a concrete similarity reason.",
    expectedBehavior: "answer",
    requiredColumns: ["entity_name", "official_website", "why_similar", "source_url"],
    expectedEntities: [
      {
        id: "you-com",
        label: "You.com",
        aliases: ["you.com", "youcom"],
        allowedSourceDomains: ["you.com"],
        requiredText: ["search", "answer", "ai"],
      },
      {
        id: "glean",
        label: "Glean",
        aliases: ["glean"],
        allowedSourceDomains: ["glean.com"],
        requiredText: ["search", "workplace", "ai"],
      },
      {
        id: "exa",
        label: "Exa",
        aliases: ["exa"],
        allowedSourceDomains: ["exa.ai"],
        requiredText: ["search", "web", "ai"],
      },
    ],
    minimumExpectedEntityMatches: 1,
  },
};
