#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPromptsPath = join(scriptDir, "prompts.json");
const defaultMinimumFactualAccuracy = 0.75;

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const allPrompts = JSON.parse(await readFile(config.promptsPath, "utf8"));
  const prompts = selectPrompts(allPrompts, config.promptIds);
  const runStartedAt = new Date();
  const runDirectory = config.outDirectory ?? join(
    process.cwd(),
    "benchmark-results",
    runStartedAt.toISOString().replace(/[:.]/g, "-")
  );

  if (config.rescoreDirectory) {
    const rescoredSummary = await rescoreBenchmarkRun({
      runDirectory: config.rescoreDirectory,
      prompts,
      config,
    });
    await writeJson(join(config.rescoreDirectory, "summary.rescored.json"), rescoredSummary);
    await writeMarkdownReport(
      join(config.rescoreDirectory, "benchmark-report.rescored.md"),
      rescoredSummary,
      prompts
    );
    console.log(JSON.stringify(rescoredSummary, null, 2));
    process.exit(0);
  }

  if (config.systems.length === 0) {
    console.error("No systems configured. Pass --system name='command with {{promptJson}}'.");
    process.exit(1);
  }

  await mkdir(runDirectory, { recursive: true });

  const laneResults = [];
  for (const system of config.systems) {
    for (const [promptIndex, promptDefinition] of prompts.entries()) {
      const result = await runSystemPrompt({
        system,
        promptDefinition,
        promptIndex,
        promptCount: prompts.length,
        runDirectory,
        config,
      });
      laneResults.push(result);
    }
  }

  const summary = {
    testedAt: runStartedAt.toISOString(),
    completedAt: new Date().toISOString(),
    wallClockMs: Date.now() - runStartedAt.getTime(),
    promptCount: prompts.length,
    promptMix: promptMixSummary(prompts),
    systems: config.systems.map(({ name }) => name),
    costAssumptions: {
      inputUsdPer1M: config.inputUsdPer1M,
      outputUsdPer1M: config.outputUsdPer1M,
      tinyFishAgentStepUsd: config.tinyFishAgentStepUsd,
    },
    aggregate: aggregateResults(laneResults),
    laneResults,
  };

  await writeJson(join(runDirectory, "summary.json"), summary);
  await writeMarkdownReport(join(runDirectory, "benchmark-report.md"), summary, prompts);
  console.log(JSON.stringify(summary, null, 2));
}

const verifiedAt = "2026-05-20";
const answerKeysByPromptId = {
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
    verifiedAt,
    sourceUrls: [
      "https://stripe.com/pricing",
      "https://www.paddle.com/billing",
      "https://www.chargebee.com/pricing/",
    ],
    scoringNotes:
      "Pass requires all three vendors, official domains, and visible plan or price text. Paddle may route pricing through Billing or sales-led pages.",
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
        requiredText: ["merchant of record", "billing"],
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
    verifiedAt,
    sourceUrls: [
      "https://www.apple.com/newsroom/2026/04/apple-reports-second-quarter-results/",
      "https://www.microsoft.com/en-us/investor/earnings/fy-2026-q3/press-release-webcast",
      "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-Fourth-Quarter-and-Fiscal-2026/",
    ],
    scoringNotes:
      "As of 2026-05-20, Apple latest verified release is fiscal 2026 Q2 on 2026-04-30, Microsoft is FY26 Q3 on 2026-04-29, and NVIDIA is Q4 fiscal 2026 on 2026-02-25.",
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
        requiredText: ["fourth quarter", "q4", "fiscal 2026"],
      },
    ],
    minimumExpectedEntityMatches: 3,
    officialSourceDomains: ["apple.com", "microsoft.com", "nvidia.com"],
  },
  "mcp-docs-pages": {
    verifiedAt,
    sourceUrls: [
      "https://developers.openai.com/api/docs/mcp",
      "https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector",
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
        allowedSourceDomains: ["docs.anthropic.com"],
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

await main();

async function runSystemPrompt(input) {
  const startedAt = Date.now();
  const minimumRequiredColumns = minimumRequiredColumnsForPrompt(
    input.promptDefinition
  );
  const command = renderCommand(input.system.command, input.promptDefinition);
  console.error(
    `[${input.system.name}] ${input.promptIndex + 1}/${input.promptCount} ${input.promptDefinition.id}`
  );

  const execution = await runCommand({
    command,
    timeoutMs: input.config.timeoutMs,
    env: {
      BIGSET_BENCHMARK_PROMPT: input.promptDefinition.prompt,
      BIGSET_BENCHMARK_PROMPT_ID: input.promptDefinition.id,
      BIGSET_BENCHMARK_PROMPT_QUALITY: input.promptDefinition.quality,
      BIGSET_BENCHMARK_REQUIRED_COLUMNS: input.promptDefinition.requiredColumns.join(","),
      BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS: minimumRequiredColumns.join(","),
    },
  });
  const parsedPayload = parseJsonPayload(execution.stdout);
  const normalized = normalizePayload(parsedPayload);
  const validation = evaluateRows({
    rows: normalized.rows,
    promptDefinition: input.promptDefinition,
  });
  const answerKeyScore = scoreBenchmarkRows({
    promptDefinition: input.promptDefinition,
    rows: normalized.rows,
    validationIssues: normalized.validationIssues,
    validation,
    minRequiredCompleteness: input.config.minRequiredCompleteness,
    minFactualAccuracy: input.config.minFactualAccuracy,
  });
  const usage = normalized.usage;
  const estimatedModelCostUsd = estimateModelCostUsd(usage, input.config);
  const estimatedTinyFishAgentCostUsd = roundUsd(
    normalized.metrics.agentStepCount * input.config.tinyFishAgentStepUsd
  );
  const infraBlockerReason = findInfrastructureBlockerReason({
    execution,
    parsedPayload,
    normalized,
  });
  const status = infraBlockerReason
    ? "blocked"
    : execution.exitCode === 0 && parsedPayload && answerKeyScore.passed
      ? "ok"
      : "failed";

  const promptRunDirectory = join(
    input.runDirectory,
    input.system.name,
    `${String(input.promptIndex + 1).padStart(2, "0")}-${input.promptDefinition.id}`
  );
  await mkdir(promptRunDirectory, { recursive: true });
  await writeFile(join(promptRunDirectory, "stdout.txt"), execution.stdout);
  await writeFile(join(promptRunDirectory, "stderr.txt"), execution.stderr);
  await writeJson(join(promptRunDirectory, "parsed-output.json"), parsedPayload ?? {
    error: "No JSON object found in stdout.",
  });

  return {
    system: input.system.name,
    promptId: input.promptDefinition.id,
    promptQuality: input.promptDefinition.quality,
    promptPersona: input.promptDefinition.persona,
    prompt: input.promptDefinition.prompt,
    requestedColumns: input.promptDefinition.requiredColumns,
    requiredColumns: input.promptDefinition.requiredColumns,
    minimumRequiredColumns,
    expectedStress: input.promptDefinition.expectedStress,
    answerKey: answerKeyForPrompt(input.promptDefinition),
    status,
    failureCategory: status === "ok" ? undefined : (
      infraBlockerReason ? "infra" : answerKeyScore.failureCategory
    ),
    factualAccuracyScore: answerKeyScore.factualAccuracyScore,
    entityCoverageRatio: answerKeyScore.entityCoverageRatio,
    domainAccuracyRatio: answerKeyScore.domainAccuracyRatio,
    evidenceSupportRatio: answerKeyScore.evidenceSupportRatio,
    claimSupportRatio: answerKeyScore.claimSupportRatio,
    abstentionScore: answerKeyScore.abstentionScore,
    matchedExpectedEntities: answerKeyScore.matchedExpectedEntities,
    missingExpectedEntities: answerKeyScore.missingExpectedEntities,
    latencyMs: Date.now() - startedAt,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    rowCount: validation.rowCount,
    nonEmptyCellCount: validation.nonEmptyCellCount,
    totalExpectedCellCount: validation.totalExpectedCellCount,
    requestedCellCompletenessRatio: validation.requestedCellCompletenessRatio,
    requiredCellCompletenessRatio: validation.requiredCellCompletenessRatio,
    sourceUrlCount: validation.sourceUrlCount,
    evidenceQuoteCount: validation.evidenceQuoteCount,
    duplicateIdentityCount: validation.duplicateIdentityCount,
    missingRequestedCellCount: validation.missingRequestedCellCount,
    missingRequestedCells: validation.missingRequestedCells,
    missingRequiredCellCount: validation.missingRequiredCellCount,
    missingRequiredCells: validation.missingRequiredCells,
    needsReviewCount: validation.needsReviewCount,
    validationIssueCount: normalized.validationIssues.length,
    validationIssues: normalized.validationIssues,
    usage,
    searchCallCount: normalized.metrics.searchCallCount,
    fetchCallCount: normalized.metrics.fetchCallCount,
    browserCallCount: normalized.metrics.browserCallCount,
    agentRunCount: normalized.metrics.agentRunCount,
    agentStepCount: normalized.metrics.agentStepCount,
    estimatedModelCostUsd,
    estimatedTinyFishAgentCostUsd,
    estimatedTotalCostUsd: roundUsd(estimatedModelCostUsd + estimatedTinyFishAgentCostUsd),
    artifactDirectory: promptRunDirectory,
    errorMessage: status === "ok"
      ? undefined
      : failureReason({
        execution,
        parsedPayload,
        validation,
        answerKeyScore,
        infraBlockerReason,
        minRequiredCompleteness: input.config.minRequiredCompleteness,
      }),
  };
}

function minimumRequiredColumnsForPrompt(promptDefinition) {
  if (Array.isArray(promptDefinition.minimumRequiredColumns)) {
    return uniqueStrings(promptDefinition.minimumRequiredColumns);
  }
  return inferConservativeMinimumRequiredColumns(promptDefinition.requiredColumns ?? []);
}

function inferConservativeMinimumRequiredColumns(columns) {
  const requestedColumns = uniqueStrings(columns);
  const identityPriority = [
    "entity_name",
    "company_name",
    "organization_name",
    "provider_name",
    "restaurant_name",
    "store_name",
    "business_name",
    "bakery_name",
    "product_name",
    "person_name",
    "profile_name",
    "docs_title",
    "latest_item_title",
    "open_role_title",
  ];
  const identityUrlPriority = [
    "company_domain",
    "official_website",
    "official_source_url",
    "profile_url",
    "linkedin_url",
    "product_url",
    "website_url",
    "docs_url",
    "careers_page_url",
    "quote_page_url",
    "menu_url",
    "pricing_page_url",
  ];

  const prioritizedIdentityColumn = identityPriority.find((columnName) =>
    requestedColumns.includes(columnName)
  );
  if (prioritizedIdentityColumn) {
    return [prioritizedIdentityColumn];
  }

  const nameColumn = requestedColumns.find((columnName) =>
    /(^|_)name$/.test(columnName)
  );
  if (nameColumn) {
    return [nameColumn];
  }

  const titleColumn = requestedColumns.find((columnName) =>
    /(^|_)title$/.test(columnName)
  );
  if (titleColumn) {
    return [titleColumn];
  }

  const identityUrlColumn = identityUrlPriority.find((columnName) =>
    requestedColumns.includes(columnName)
  );
  if (identityUrlColumn) {
    return [identityUrlColumn];
  }

  const fallbackIdentityColumn = requestedColumns.find(
    (columnName) =>
      columnName !== "source_url" &&
      !columnName.endsWith("_at") &&
      !columnName.includes("score") &&
      !columnName.startsWith("is_") &&
      !columnName.startsWith("has_")
  );

  return fallbackIdentityColumn ? [fallbackIdentityColumn] : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function parseArgs(args) {
  const config = {
    promptsPath: defaultPromptsPath,
    promptIds: null,
    systems: [],
    timeoutMs: 10 * 60 * 1000,
    inputUsdPer1M: 0.05,
    outputUsdPer1M: 0.5,
    tinyFishAgentStepUsd: 0.015,
    minRequiredCompleteness: 0.75,
    minFactualAccuracy: defaultMinimumFactualAccuracy,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--prompts") {
      config.promptsPath = value;
      index += 1;
    } else if (arg === "--prompt-ids") {
      config.promptIds = parsePromptIds(value);
      index += 1;
    } else if (arg === "--out") {
      config.outDirectory = value;
      index += 1;
    } else if (arg === "--rescore-dir") {
      config.rescoreDirectory = value;
      index += 1;
    } else if (arg === "--system") {
      const parsed = parseSystem(value);
      config.systems.push(parsed);
      index += 1;
    } else if (arg === "--timeout-ms") {
      config.timeoutMs = positiveNumber(value, config.timeoutMs);
      index += 1;
    } else if (arg === "--input-usd-per-1m") {
      config.inputUsdPer1M = nonNegativeNumber(value, config.inputUsdPer1M);
      index += 1;
    } else if (arg === "--output-usd-per-1m") {
      config.outputUsdPer1M = nonNegativeNumber(value, config.outputUsdPer1M);
      index += 1;
    } else if (arg === "--tinyfish-agent-step-usd") {
      config.tinyFishAgentStepUsd = nonNegativeNumber(value, config.tinyFishAgentStepUsd);
      index += 1;
    } else if (arg === "--min-required-completeness") {
      config.minRequiredCompleteness = nonNegativeNumber(value, config.minRequiredCompleteness);
      index += 1;
    } else if (arg === "--min-factual-accuracy") {
      config.minFactualAccuracy = nonNegativeNumber(value, config.minFactualAccuracy);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

function parsePromptIds(value) {
  const promptIds = value
    .split(",")
    .map((promptId) => promptId.trim())
    .filter(Boolean);

  if (promptIds.length === 0) {
    throw new Error("--prompt-ids requires at least one prompt id");
  }

  return promptIds;
}

function selectPrompts(prompts, promptIds) {
  if (!promptIds) {
    return prompts;
  }

  const promptsById = new Map(prompts.map((promptDefinition) => [
    promptDefinition.id,
    promptDefinition,
  ]));
  const selectedPrompts = [];
  const missingPromptIds = [];

  for (const promptId of promptIds) {
    const promptDefinition = promptsById.get(promptId);
    if (promptDefinition) {
      selectedPrompts.push(promptDefinition);
    } else {
      missingPromptIds.push(promptId);
    }
  }

  if (missingPromptIds.length > 0) {
    const availablePromptIds = prompts.map((promptDefinition) => promptDefinition.id).join(", ");
    throw new Error(
      `Unknown prompt id(s): ${missingPromptIds.join(", ")}. Available ids: ${availablePromptIds}`
    );
  }

  return selectedPrompts;
}

function parseSystem(value) {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error("--system must look like name=command");
  }

  return {
    name: value.slice(0, separatorIndex).trim(),
    command: value.slice(separatorIndex + 1).trim(),
  };
}

function renderCommand(command, promptDefinition) {
  const minimumRequiredColumns = minimumRequiredColumnsForPrompt(promptDefinition);
  return command
    .replaceAll("{{prompt}}", shellEscape(promptDefinition.prompt))
    .replaceAll("{{promptJson}}", shellEscape(JSON.stringify(promptDefinition.prompt)))
    .replaceAll("{{promptId}}", shellEscape(promptDefinition.id))
    .replaceAll("{{requiredColumnsJson}}", shellEscape(JSON.stringify(promptDefinition.requiredColumns)))
    .replaceAll("{{minimumRequiredColumnsJson}}", shellEscape(JSON.stringify(minimumRequiredColumns)));
}

function runCommand({ command, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut });
    });
  });
}

function parseJsonPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lastObject = extractLastJsonObject(trimmed);
    if (!lastObject) {
      return null;
    }
    try {
      return JSON.parse(lastObject);
    } catch {
      return null;
    }
  }
}

function extractLastJsonObject(value) {
  let depth = 0;
  let endIndex = -1;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (char === "}") {
      if (endIndex === -1) {
        endIndex = index;
      }
      depth += 1;
    } else if (char === "{") {
      depth -= 1;
      if (depth === 0 && endIndex !== -1) {
        return value.slice(index, endIndex + 1);
      }
    }
  }
  return null;
}

function normalizePayload(payload) {
  const rows = arrayValue(
    payload?.rows ??
      payload?.data ??
      payload?.records ??
      payload?.result ??
      payload?.datasetRows
  );
  const validationIssues = stringArrayValue(
    payload?.validationIssues ?? payload?.issues ?? payload?.errors
  );
  const metrics = payload?.metrics ?? payload?.benchmarkMetrics ?? {};
  const usage = normalizeUsage(payload?.usage ?? metrics.usage ?? metrics);

  return {
    rows,
    validationIssues,
    usage,
    metrics: {
      searchCallCount: numberValue(metrics.searchCallCount ?? metrics.searchCalls),
      fetchCallCount: numberValue(metrics.fetchCallCount ?? metrics.fetchCalls),
      browserCallCount: numberValue(metrics.browserCallCount ?? metrics.browserCalls),
      agentRunCount: numberValue(metrics.agentRunCount ?? metrics.agentRuns),
      agentStepCount: numberValue(metrics.agentStepCount ?? metrics.agentSteps),
    },
  };
}

function normalizeUsage(value) {
  return {
    promptTokens: numberValue(value?.promptTokens ?? value?.inputTokens ?? value?.prompt_tokens),
    completionTokens: numberValue(
      value?.completionTokens ?? value?.outputTokens ?? value?.completion_tokens
    ),
    totalTokens: numberValue(value?.totalTokens ?? value?.total_tokens),
  };
}

function evaluateRows({ rows, promptDefinition }) {
  const missingRequiredCells = [];
  const sourceUrls = new Set();
  const identityKeys = new Set();
  let duplicateIdentityCount = 0;
  let nonEmptyCellCount = 0;
  let evidenceQuoteCount = 0;
  let needsReviewCount = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const cells = rowCells(row);
    const identity = identityKey(cells, row);
    if (identity) {
      if (identityKeys.has(identity)) {
        duplicateIdentityCount += 1;
      }
      identityKeys.add(identity);
    }

    for (const requiredColumn of promptDefinition.requiredColumns) {
      const value = cells[requiredColumn] ?? row?.[requiredColumn];
      if (isPresent(value)) {
        nonEmptyCellCount += 1;
      } else {
        missingRequiredCells.push({ rowIndex, column: requiredColumn });
      }
    }

    for (const url of rowSourceUrls(row, cells)) {
      sourceUrls.add(url);
    }
    evidenceQuoteCount += rowEvidenceQuoteCount(row);
    if (row?.needsReview === true || row?.needs_review === true) {
      needsReviewCount += 1;
    }
  }

  const totalExpectedCellCount = rows.length * promptDefinition.requiredColumns.length;
  const requiredCellCompletenessRatio = totalExpectedCellCount === 0
    ? 0
    : roundRatio(nonEmptyCellCount / totalExpectedCellCount);

  return {
    rowCount: rows.length,
    nonEmptyCellCount,
    totalExpectedCellCount,
    requestedCellCompletenessRatio: requiredCellCompletenessRatio,
    requiredCellCompletenessRatio,
    sourceUrlCount: sourceUrls.size,
    evidenceQuoteCount,
    duplicateIdentityCount,
    missingRequestedCellCount: missingRequiredCells.length,
    missingRequestedCells: missingRequiredCells,
    missingRequiredCellCount: missingRequiredCells.length,
    missingRequiredCells,
    needsReviewCount,
  };
}

async function rescoreBenchmarkRun({ runDirectory, prompts, config }) {
  const previousSummary = JSON.parse(await readFile(join(runDirectory, "summary.json"), "utf8"));
  const promptsById = new Map(prompts.map((promptDefinition) => [
    promptDefinition.id,
    promptDefinition,
  ]));
  const rescoredLaneResults = [];

  for (const laneResult of previousSummary.laneResults ?? []) {
    if (config.promptIds && !config.promptIds.includes(laneResult.promptId)) {
      continue;
    }

    const promptDefinition = promptsById.get(laneResult.promptId);
    if (!promptDefinition) {
      rescoredLaneResults.push(laneResult);
      continue;
    }

    const artifactDirectory = laneResult.artifactDirectory ??
      join(runDirectory, laneResult.system, laneResult.promptId);
    const parsedPayload = await readJsonOrNull(join(artifactDirectory, "parsed-output.json"));
    const stdout = await readTextOrEmpty(join(artifactDirectory, "stdout.txt"));
    const stderr = await readTextOrEmpty(join(artifactDirectory, "stderr.txt"));
    const usablePayload = parsedPayload?.error ? null : parsedPayload;
    const normalized = normalizePayload(usablePayload);
    const validation = evaluateRows({ rows: normalized.rows, promptDefinition });
    const answerKeyScore = scoreBenchmarkRows({
      promptDefinition,
      rows: normalized.rows,
      validationIssues: normalized.validationIssues,
      validation,
      minRequiredCompleteness: config.minRequiredCompleteness,
      minFactualAccuracy: config.minFactualAccuracy,
    });
    const execution = {
      stdout,
      stderr,
      exitCode: laneResult.exitCode ?? 0,
      timedOut: Boolean(laneResult.timedOut),
    };
    const infraBlockerReason = findInfrastructureBlockerReason({
      execution,
      parsedPayload: usablePayload,
      normalized,
    });
    const status = infraBlockerReason
      ? "blocked"
      : execution.exitCode === 0 && usablePayload && answerKeyScore.passed
        ? "ok"
        : "failed";

    rescoredLaneResults.push({
      ...laneResult,
      requestedColumns: promptDefinition.requiredColumns,
      requiredColumns: promptDefinition.requiredColumns,
      minimumRequiredColumns: minimumRequiredColumnsForPrompt(promptDefinition),
      expectedStress: promptDefinition.expectedStress,
      answerKey: answerKeyForPrompt(promptDefinition),
      status,
      failureCategory: status === "ok" ? undefined : (
        infraBlockerReason ? "infra" : answerKeyScore.failureCategory
      ),
      factualAccuracyScore: answerKeyScore.factualAccuracyScore,
      entityCoverageRatio: answerKeyScore.entityCoverageRatio,
      domainAccuracyRatio: answerKeyScore.domainAccuracyRatio,
      evidenceSupportRatio: answerKeyScore.evidenceSupportRatio,
      claimSupportRatio: answerKeyScore.claimSupportRatio,
      abstentionScore: answerKeyScore.abstentionScore,
      matchedExpectedEntities: answerKeyScore.matchedExpectedEntities,
      missingExpectedEntities: answerKeyScore.missingExpectedEntities,
      rowCount: validation.rowCount,
      nonEmptyCellCount: validation.nonEmptyCellCount,
      totalExpectedCellCount: validation.totalExpectedCellCount,
      requestedCellCompletenessRatio: validation.requestedCellCompletenessRatio,
      requiredCellCompletenessRatio: validation.requiredCellCompletenessRatio,
      sourceUrlCount: validation.sourceUrlCount,
      evidenceQuoteCount: validation.evidenceQuoteCount,
      duplicateIdentityCount: validation.duplicateIdentityCount,
      missingRequestedCellCount: validation.missingRequestedCellCount,
      missingRequestedCells: validation.missingRequestedCells,
      missingRequiredCellCount: validation.missingRequiredCellCount,
      missingRequiredCells: validation.missingRequiredCells,
      needsReviewCount: validation.needsReviewCount,
      validationIssueCount: normalized.validationIssues.length,
      validationIssues: normalized.validationIssues,
      errorMessage: status === "ok"
        ? undefined
        : failureReason({
          execution,
          parsedPayload: usablePayload,
          validation,
          answerKeyScore,
          infraBlockerReason,
          minRequiredCompleteness: config.minRequiredCompleteness,
        }),
    });
  }

  return {
    ...previousSummary,
    rescoredAt: new Date().toISOString(),
    aggregate: aggregateResults(rescoredLaneResults),
    laneResults: rescoredLaneResults,
  };
}

function scoreBenchmarkRows(input) {
  const answerKey = answerKeyForPrompt(input.promptDefinition);
  const rowTexts = input.rows.map(rowSearchText);
  const validationIssueText = input.validationIssues.join(" ").toLowerCase();
  const allText = [...rowTexts, validationIssueText].join(" ");
  const expectedEntities = answerKey.expectedEntities ?? [];
  const matchedExpectedEntities = [];
  const missingExpectedEntities = [];
  let expectedEntityDomainMatches = 0;
  let expectedEntityClaimMatches = 0;

  for (const expectedEntity of expectedEntities) {
    const aliases = expectedEntity.aliases ?? [expectedEntity.label, expectedEntity.id];
    const aliasMatched = aliases.some((alias) => allText.includes(String(alias).toLowerCase()));
    if (!aliasMatched) {
      missingExpectedEntities.push(expectedEntity.label ?? expectedEntity.id);
      continue;
    }

    matchedExpectedEntities.push(expectedEntity.label ?? expectedEntity.id);
    const entityRows = input.rows.filter((row) => {
      const rowText = rowSearchText(row);
      return aliases.some((alias) => rowText.includes(String(alias).toLowerCase()));
    });
    const rowsToCheck = entityRows.length > 0 ? entityRows : input.rows;
    if (rowsToCheck.some((row) => rowHasAllowedDomain(row, expectedEntity.allowedSourceDomains))) {
      expectedEntityDomainMatches += 1;
    }
    if (
      !expectedEntity.requiredText?.length ||
      rowsToCheck.some((row) => textContainsAny(rowSearchText(row), expectedEntity.requiredText))
    ) {
      expectedEntityClaimMatches += 1;
    }
  }

  const minimumEntityMatches = answerKey.minimumExpectedEntityMatches ?? expectedEntities.length;
  const entityCoverageRatio = expectedEntities.length === 0
    ? 1
    : roundRatio(matchedExpectedEntities.length / Math.max(1, minimumEntityMatches));
  const domainAccuracyRatio = expectedEntities.length > 0
    ? roundRatio(expectedEntityDomainMatches / Math.max(1, matchedExpectedEntities.length))
    : domainCoverageRatio(input.rows, answerKeyDomains(answerKey));
  const evidenceSupportRatio = input.validation.rowCount === 0
    ? 0
    : roundRatio(input.validation.evidenceQuoteCount / Math.max(1, input.validation.rowCount));
  const claimSupportRatio = claimSupportRatioForRows({
    rows: input.rows,
    answerKey,
    expectedEntities,
    expectedEntityClaimMatches,
    matchedExpectedEntityCount: matchedExpectedEntities.length,
  });
  const abstentionScore = answerKey.expectedBehavior === "clarify_or_abstain"
    ? clarificationScore(allText, answerKey.clarificationTerms ?? [])
    : 0;
  const shapeScore = shapeScoreForRows({
    validation: input.validation,
    minRequiredCompleteness: input.minRequiredCompleteness,
    expectedBehavior: answerKey.expectedBehavior,
    validationIssues: input.validationIssues,
  });
  const factualAccuracyScore = answerKey.expectedBehavior === "clarify_or_abstain"
    ? roundRatio(
      shapeScore * 0.2 +
        domainAccuracyRatio * 0.2 +
        abstentionScore * 0.6
    )
    : roundRatio(
      shapeScore * 0.25 +
        Math.min(1, entityCoverageRatio) * 0.3 +
        domainAccuracyRatio * 0.2 +
        Math.min(1, evidenceSupportRatio) * 0.15 +
        claimSupportRatio * 0.1
    );
  const minimumScore = answerKey.minimumScore ?? input.minFactualAccuracy;
  const hasExpectedEntityCoverage = expectedEntities.length === 0 ||
    matchedExpectedEntities.length >= minimumEntityMatches;
  const hasRequiredDomainAccuracy = !requiresDomainProof(answerKey, expectedEntities) ||
    domainAccuracyRatio >= 1;
  const hasRequiredClaimSupport = !requiresClaimProof(answerKey, expectedEntities) ||
    claimSupportRatio >= 1;
  const passed = answerKey.expectedBehavior === "clarify_or_abstain"
    ? factualAccuracyScore >= minimumScore && abstentionScore >= 0.5
    : factualAccuracyScore >= minimumScore &&
      shapeScore >= 1 &&
      hasExpectedEntityCoverage &&
      hasRequiredDomainAccuracy &&
      hasRequiredClaimSupport;

  return {
    passed,
    failureCategory: failureCategoryForScore({
      answerKey,
      parsedRows: input.rows,
      shapeScore,
      entityCoverageRatio,
      domainAccuracyRatio,
      evidenceSupportRatio,
      claimSupportRatio,
      abstentionScore,
      factualAccuracyScore,
      minimumScore,
    }),
    factualAccuracyScore,
    entityCoverageRatio: roundRatio(Math.min(1, entityCoverageRatio)),
    domainAccuracyRatio,
    evidenceSupportRatio: roundRatio(Math.min(1, evidenceSupportRatio)),
    claimSupportRatio,
    abstentionScore,
    matchedExpectedEntities,
    missingExpectedEntities,
    minimumScore,
  };
}

function answerKeyForPrompt(promptDefinition) {
  return promptDefinition.answerKey ?? answerKeysByPromptId[promptDefinition.id] ?? {
    expectedBehavior: "answer",
    requiredColumns: promptDefinition.requiredColumns,
    sourceUrls: [],
    scoringNotes: "No prompt-specific answer key. Falling back to shape-only scoring.",
  };
}

function shapeScoreForRows({ validation, minRequiredCompleteness, expectedBehavior, validationIssues }) {
  if (expectedBehavior === "clarify_or_abstain" && validationIssues.length > 0) {
    return 1;
  }
  if (validation.rowCount === 0 || validation.sourceUrlCount === 0 || validation.evidenceQuoteCount === 0) {
    return 0;
  }
  if (validation.requiredCellCompletenessRatio < minRequiredCompleteness) {
    return roundRatio(validation.requiredCellCompletenessRatio / Math.max(0.001, minRequiredCompleteness));
  }
  return 1;
}

function claimSupportRatioForRows({
  rows,
  answerKey,
  expectedEntities,
  expectedEntityClaimMatches,
  matchedExpectedEntityCount,
}) {
  if (answerKey.rowMustContainAny?.length) {
    const matchingRows = rows.filter((row) =>
      textContainsAny(rowSearchText(row), answerKey.rowMustContainAny)
    ).length;
    return rows.length === 0 ? 0 : roundRatio(matchingRows / rows.length);
  }
  if (expectedEntities.some((entity) => entity.requiredText?.length)) {
    return roundRatio(expectedEntityClaimMatches / Math.max(1, matchedExpectedEntityCount));
  }
  return rows.length > 0 ? 1 : 0;
}

function domainCoverageRatio(rows, allowedDomains) {
  if (!allowedDomains?.length) {
    if (rows.length === 0) return 0;
    const hasPlaceholderOnly = rows.every((row) => {
      const cells = rowCells(row);
      const hostnames = rowSourceUrls(row, cells).map(urlHostname).filter(Boolean);
      return hostnames.length > 0 && hostnames.every(isPlaceholderHostname);
    });
    return hasPlaceholderOnly ? 0 : 1;
  }
  if (rows.length === 0) return 0;
  const matchingRows = rows.filter((row) => rowHasAllowedDomain(row, allowedDomains)).length;
  return roundRatio(matchingRows / rows.length);
}

function answerKeyDomains(answerKey) {
  const configuredDomains = answerKey.officialSourceDomains ?? [];
  const sourceDomains = (answerKey.sourceUrls ?? []).map(urlHostname).filter(Boolean);
  return [...new Set([...configuredDomains, ...sourceDomains])];
}

function requiresDomainProof(answerKey, expectedEntities) {
  return answerKeyDomains(answerKey).length > 0 ||
    expectedEntities.some((entity) => entity.allowedSourceDomains?.length);
}

function requiresClaimProof(answerKey, expectedEntities) {
  return Boolean(answerKey.rowMustContainAny?.length) ||
    expectedEntities.some((entity) => entity.requiredText?.length);
}

function isPlaceholderHostname(hostname) {
  return hostname === "example.com" ||
    hostname.endsWith(".example.com") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1";
}

function clarificationScore(text, terms) {
  if (terms.length === 0) return text.length > 0 ? 1 : 0;
  const matchedTerms = terms.filter((term) => text.includes(term.toLowerCase())).length;
  return roundRatio(matchedTerms / terms.length);
}

function failureCategoryForScore(input) {
  if (input.parsedRows.length === 0 && input.answerKey.expectedBehavior !== "clarify_or_abstain") {
    return "schema";
  }
  if (input.shapeScore < 1) return "source_evidence";
  if (input.answerKey.expectedBehavior === "clarify_or_abstain" && input.abstentionScore < 0.5) {
    return "clarification";
  }
  if (input.entityCoverageRatio < 1) return "factual_accuracy";
  if (input.domainAccuracyRatio < 1) return "source_evidence";
  if (input.claimSupportRatio < 1) return "factual_accuracy";
  if (input.factualAccuracyScore < input.minimumScore) return "factual_accuracy";
  return "factual_accuracy";
}

function findInfrastructureBlockerReason({ execution, parsedPayload, normalized }) {
  const combinedText = [
    execution.stderr,
    execution.stdout,
    JSON.stringify(parsedPayload ?? {}),
    ...(normalized?.validationIssues ?? []),
  ].join("\n").toLowerCase();

  if (execution.timedOut) return "Command timed out.";
  const blockerPatterns = [
    "authentication failed",
    "active subscription",
    "insufficient credits",
    "not enough credits",
    "api key",
    "tinyfish_api_key",
    "quota",
    "rate limit",
    "benchmark deadline",
  ];
  return blockerPatterns.some((pattern) => combinedText.includes(pattern))
    ? "Infrastructure/auth/credits blocker."
    : null;
}

function aggregateResults(results) {
  const groups = new Map();
  for (const result of results) {
    groups.set(result.system, [...(groups.get(result.system) ?? []), result]);
  }

  return Array.from(groups.entries()).map(([system, group]) => {
    const passed = group.filter((result) => result.status === "ok").length;
    const blocked = group.filter((result) => result.status === "blocked").length;
    const failed = group.length - passed - blocked;
    const eligibleGroup = group.filter((result) => result.status !== "blocked");
    const eligibleCount = eligibleGroup.length;
    const totalLatencyMs = sum(group, "latencyMs");
    const totalEstimatedCostUsd = sum(group, "estimatedTotalCostUsd");
    return {
      system,
      total: group.length,
      passed,
      failed,
      blocked,
      passRate: roundRatio(passed / Math.max(1, group.length)),
      eligiblePassRate: roundRatio(passed / Math.max(1, eligibleCount)),
      wallClockMs: totalLatencyMs,
      avgLatencyMs: Math.round(totalLatencyMs / Math.max(1, group.length)),
      avgRequiredCellCompletenessRatio: roundRatio(
        sum(eligibleGroup, "requiredCellCompletenessRatio") / Math.max(1, eligibleCount)
      ),
      avgRequestedCellCompletenessRatio: roundRatio(
        sum(eligibleGroup, "requestedCellCompletenessRatio") / Math.max(1, eligibleCount)
      ),
      avgFactualAccuracyScore: roundRatio(
        sum(eligibleGroup, "factualAccuracyScore") / Math.max(1, eligibleCount)
      ),
      avgEntityCoverageRatio: roundRatio(
        sum(eligibleGroup, "entityCoverageRatio") / Math.max(1, eligibleCount)
      ),
      avgDomainAccuracyRatio: roundRatio(
        sum(eligibleGroup, "domainAccuracyRatio") / Math.max(1, eligibleCount)
      ),
      totalRows: sum(group, "rowCount"),
      totalEvidenceQuotes: sum(group, "evidenceQuoteCount"),
      totalSourceUrls: sum(group, "sourceUrlCount"),
      totalMissingRequestedCells: sum(group, "missingRequestedCellCount"),
      totalMissingRequiredCells: sum(group, "missingRequiredCellCount"),
      totalDuplicateIdentities: sum(group, "duplicateIdentityCount"),
      totalPromptTokens: group.reduce((total, result) => total + result.usage.promptTokens, 0),
      totalCompletionTokens: group.reduce((total, result) => total + result.usage.completionTokens, 0),
      totalTokens: group.reduce((total, result) => total + result.usage.totalTokens, 0),
      searchCallCount: sum(group, "searchCallCount"),
      fetchCallCount: sum(group, "fetchCallCount"),
      browserCallCount: sum(group, "browserCallCount"),
      agentRunCount: sum(group, "agentRunCount"),
      agentStepCount: sum(group, "agentStepCount"),
      estimatedTotalCostUsd: roundUsd(totalEstimatedCostUsd),
    };
  });
}

async function writeMarkdownReport(filePath, summary, prompts) {
  const lines = [
    "# Dataset Agent Benchmark Report",
    "",
    `Tested: ${summary.testedAt}`,
    `Completed: ${summary.completedAt}`,
    `Wall clock: ${formatDuration(summary.wallClockMs)}`,
    `Prompt mix: good ${summary.promptMix.good}, average ${summary.promptMix.average}, bad ${summary.promptMix.bad}`,
    "",
    "## Aggregate",
    "",
    "| System | Runs | Passed | Failed | Blocked | Pass Rate | Eligible Pass | Avg Accuracy | Avg Latency | Rows | Evidence | Sources | Completeness | Missing Requested | Duplicates | Tokens In | Tokens Out | Agent Steps | Est Cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.aggregate.map((row) =>
      `| ${escapeMarkdown(row.system)} | ${row.total} | ${row.passed} | ${row.failed} | ${row.blocked} | ${row.passRate} | ${row.eligiblePassRate} | ${row.avgFactualAccuracyScore} | ${formatDuration(row.avgLatencyMs)} | ${row.totalRows} | ${row.totalEvidenceQuotes} | ${row.totalSourceUrls} | ${row.avgRequestedCellCompletenessRatio ?? row.avgRequiredCellCompletenessRatio} | ${row.totalMissingRequestedCells ?? row.totalMissingRequiredCells} | ${row.totalDuplicateIdentities} | ${row.totalPromptTokens} | ${row.totalCompletionTokens} | ${row.agentStepCount} | ${formatUsd(row.estimatedTotalCostUsd)} |`
    ),
    "",
    "## Prompt Pack",
    "",
    "| # | Quality | Persona | Prompt | Requested Columns | Minimum Required | Stress |",
    "| ---: | --- | --- | --- | --- | --- | --- |",
    ...prompts.map((prompt, index) =>
      `| ${index + 1} | ${prompt.quality} | ${escapeMarkdown(prompt.persona)} | ${escapeMarkdown(prompt.prompt)} | ${prompt.requiredColumns.join(", ")} | ${minimumRequiredColumnsForPrompt(prompt).join(", ")} | ${escapeMarkdown(prompt.expectedStress)} |`
    ),
    "",
    "## Raw Results",
    "",
    "| System | Prompt | Quality | Status | Category | Accuracy | Entity Coverage | Domain Accuracy | Latency | Rows | Completeness | Evidence | Sources | Missing Requested | Duplicates | Tokens In | Tokens Out | Search | Fetch | Browser | Agent Runs | Agent Steps | Est Cost | Issue |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.laneResults.map((result) =>
      `| ${escapeMarkdown(result.system)} | ${escapeMarkdown(result.promptId)} | ${result.promptQuality} | ${result.status} | ${escapeMarkdown(result.failureCategory ?? "")} | ${result.factualAccuracyScore ?? 0} | ${result.entityCoverageRatio ?? 0} | ${result.domainAccuracyRatio ?? 0} | ${formatDuration(result.latencyMs)} | ${result.rowCount} | ${result.requestedCellCompletenessRatio ?? result.requiredCellCompletenessRatio} | ${result.evidenceQuoteCount} | ${result.sourceUrlCount} | ${result.missingRequestedCellCount ?? result.missingRequiredCellCount} | ${result.duplicateIdentityCount} | ${result.usage.promptTokens} | ${result.usage.completionTokens} | ${result.searchCallCount} | ${result.fetchCallCount} | ${result.browserCallCount} | ${result.agentRunCount} | ${result.agentStepCount} | ${formatUsd(result.estimatedTotalCostUsd)} | ${escapeMarkdown(result.errorMessage ?? "")} |`
    ),
    "",
  ];
  await writeFile(filePath, `${lines.join("\n")}\n`);
}

function promptMixSummary(prompts) {
  return prompts.reduce(
    (mix, prompt) => {
      mix[prompt.quality] = (mix[prompt.quality] ?? 0) + 1;
      return mix;
    },
    { good: 0, average: 0, bad: 0 }
  );
}

function estimateModelCostUsd(usage, config) {
  return roundUsd(
    (usage.promptTokens / 1_000_000) * config.inputUsdPer1M +
      (usage.completionTokens / 1_000_000) * config.outputUsdPer1M
  );
}

function rowCells(row) {
  if (isRecord(row?.cells)) return row.cells;
  if (isRecord(row?.data)) return row.data;
  return isRecord(row) ? row : {};
}

function rowSourceUrls(row, cells) {
  return [
    ...stringArrayValue(row?.sourceUrls),
    ...stringArrayValue(row?.sources),
    ...stringArrayValue(row?.source_urls),
    ...stringArrayValue(cells?.source_urls),
    ...stringArrayValue(cells?.sources),
    ...singleStringArray(row?.sourceUrl),
    ...singleStringArray(row?.source_url),
    ...singleStringArray(cells?.source_url),
    ...singleStringArray(cells?.sourceUrl),
  ].filter((value) => value.startsWith("http"));
}

function rowSearchText(row) {
  const cells = rowCells(row);
  return [
    JSON.stringify(cells),
    ...rowSourceUrls(row, cells),
    ...arrayValue(row?.evidence).map((evidence) =>
      typeof evidence === "string" ? evidence : evidence?.quote ?? ""
    ),
  ].join(" ").toLowerCase();
}

function rowHasAllowedDomain(row, allowedDomains) {
  if (!allowedDomains?.length) return true;
  const cells = rowCells(row);
  return rowSourceUrls(row, cells).some((url) =>
    allowedDomains.some((allowedDomain) => urlHostname(url).endsWith(allowedDomain))
  );
}

function textContainsAny(text, terms) {
  const lowerText = text.toLowerCase();
  return terms.some((term) => lowerText.includes(String(term).toLowerCase()));
}

function urlHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rowEvidenceQuoteCount(row) {
  return arrayValue(row?.evidence).filter((evidence) => {
    if (typeof evidence === "string") return evidence.trim().length > 0;
    return typeof evidence?.quote === "string" && evidence.quote.trim().length > 0;
  }).length;
}

function identityKey(cells, row) {
  const candidates = [
    cells.entity_name,
    cells.company_name,
    cells.product_name,
    cells.bakery_name,
    cells.provider_name,
    cells.name,
    row.id,
  ];
  const identityParts = candidates.filter(isPresent).map((value) =>
    String(value).trim().toLowerCase()
  );
  return identityParts[0] ?? null;
}

function failureReason({
  execution,
  parsedPayload,
  validation,
  answerKeyScore,
  infraBlockerReason,
  minRequiredCompleteness,
}) {
  if (infraBlockerReason) return infraBlockerReason;
  if (execution.timedOut) return "Command timed out.";
  if (execution.exitCode !== 0) return `Command exited ${execution.exitCode}.`;
  if (!parsedPayload) return "No parseable JSON object found in stdout.";
  if (answerKeyScore?.failureCategory === "clarification") {
    return `Clarification/abstention score ${answerKeyScore.abstentionScore} below required threshold.`;
  }
  if (validation.rowCount === 0) return "Parsed JSON had zero rows.";
  if (validation.sourceUrlCount === 0) return "No source URLs found.";
  if (validation.evidenceQuoteCount === 0) return "No evidence quotes found.";
  if (validation.requiredCellCompletenessRatio < minRequiredCompleteness) {
    return `Requested-cell completeness ${validation.requiredCellCompletenessRatio} below ${minRequiredCompleteness}.`;
  }
  if (answerKeyScore && !answerKeyScore.passed) {
    if (answerKeyScore.failureCategory === "source_evidence") {
      return `Source/domain evidence failed; factual accuracy ${answerKeyScore.factualAccuracyScore}, domain accuracy ${answerKeyScore.domainAccuracyRatio}.`;
    }
    return `Factual accuracy ${answerKeyScore.factualAccuracyScore} below ${answerKeyScore.minimumScore}; missing entities: ${answerKeyScore.missingExpectedEntities.join(", ") || "none"}.`;
  }
  return "Benchmark failed.";
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function singleStringArray(value) {
  return typeof value === "string" ? [value] : [];
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function sum(items, key) {
  return items.reduce((total, item) => total + numberValue(item[key]), 0);
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatUsd(value) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function roundRatio(value) {
  return Number(value.toFixed(3));
}

function roundUsd(value) {
  return Number(value.toFixed(6));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readTextOrEmpty(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function printHelpAndExit() {
  console.log(`Usage:
node benchmarks/dataset-agent/run-benchmark.mjs \\
  --system mengzhe='npm run benchmark -- {{promptJson}}' \\
  --system edward='node ./my-agent.js --prompt {{promptJson}}'

Run a canary subset before spending credits on all prompts:
node benchmarks/dataset-agent/run-benchmark.mjs \\
  --prompt-ids latest-ai-blog-posts,saas-pricing-pages \\
  --system edward='node ./my-agent.js --prompt {{promptJson}}'

Rescore existing artifacts without spending credits:
node benchmarks/dataset-agent/run-benchmark.mjs --rescore-dir benchmark-results/<run>

Agent command contract:
- stdout should contain a JSON object.
- Preferred shape: { "rows": [], "validationIssues": [], "usage": {}, "metrics": {} }
- usage supports promptTokens/inputTokens, completionTokens/outputTokens, totalTokens.
- metrics supports searchCalls, fetchCalls, browserCalls, agentRuns, agentSteps.
`);
  process.exit(0);
}
