# BigSet Codification Notes

This document summarizes the product and technical direction discussed for "codifying" recurring BigSet datasets.

## Core Idea

BigSet should use LLMs for ambiguity, but not for every repeated row extraction.

For datasets with predictable primary keys and predictable target pages — for example:

- Amazon product URLs → price, star rating, review count, availability
- YC company URLs → company metadata
- GitHub repository URLs → stars, language, license, activity
- App/package pages → ratings, pricing, installs, versions

BigSet should compile or use a deterministic browser extractor once, then run it across all rows with TinyFish Browser.

This turns BigSet from:

```txt
LLM researches every row
```

into:

```txt
LLM understands the dataset once → TinyFish Browser extracts many rows
```

## Product Motivation

BigSet is by TinyFish, and should showcase why TinyFish subscriptions are valuable.

The goal is not to minimize TinyFish usage. The goal is to produce better datasets while shifting repeatable web work away from OpenRouter token spend and toward TinyFish Browser/Agent usage.

Better data sells TinyFish.

## TinyFish Agent vs TinyFish Browser

We decided to treat TinyFish Browser as the foundational primitive for codified extraction.

### Browser API

Use Browser when BigSet knows the page pattern and can drive it with Playwright/CDP.

Good for:

- Rendering JavaScript-heavy pages
- Reading dynamic DOM content
- Scrolling / clicking load-more buttons
- Extracting from network/XHR JSON
- Running the same extractor across many similar rows
- Reducing OpenRouter usage

Browser is deterministic infrastructure.

### Agent API

Use Agent when the task is still fuzzy or requires web judgment.

Good for:

- Unknown navigation paths
- Multi-step workflows
- Sites where BigSet does not know what to click
- Fallback when a generated extractor fails
- One-off messy cases

Agent is delegation.

The preferred quality path is:

```txt
Search → Fetch → Browser → Agent fallback
```

For codified datasets, the main runtime path should be:

```txt
Browser first, Agent only when needed
```

## Codified Dataset / Extractor Compiler

A codified dataset is one where BigSet can create a reusable extractor from the schema and a representative row.

Example:

```txt
Primary key: amazon_product_url
Columns: price, star_rating, review_count, availability
```

This should not require an LLM per row. A Playwright extractor can be generated, tested, persisted, and reused.

## Schema Builder Responsibilities

Schema inference should determine more than just columns.

It should identify:

1. Whether the dataset is plausibly codifiable
2. The primary key shape, especially URL-based keys
3. The likely target site/page type
4. Column type contracts
5. Validation requirements for each column
6. Regex or normalization expectations where useful

Example column contract:

```ts
{
  name: "star_rating",
  type: "number",
  nullable: true,
  validation_regex: "^[0-5](\\.\\d)?$",
  normalization_hint: "Extract a numeric rating like 4.6 from text such as '4.6 out of 5 stars'."
}
```

The schema builder should not itself need browser access. It should decide whether a dataset is a codification candidate.

## Browser Probe

If a dataset is codifiable, BigSet should run a browser probe on the first representative row/source URL.

The browser probe should collect evidence such as:

- Final URL
- Page title
- Visible text excerpts
- DOM excerpts around likely fields
- JSON-LD / structured data
- Candidate selectors
- Network/XHR JSON hints
- Screenshot if useful

The probe output becomes context for the extractor-builder model.

## Extractor Builder Model

A dedicated model role should generate the Playwright extractor.

Current model roles are:

```txt
schemaInference
populateOrchestrator
investigateSubagent
```

We should add:

```txt
extractorBuilder
```

This model writes and repairs extractor scripts using:

- Dataset schema
- Column validation contracts
- First row input
- Browser probe artifacts
- Test failure feedback when applicable

Default recommendation:

```txt
extractorBuilder = anthropic/claude-sonnet-4.6
```

Reason: extractor generation happens once per dataset/pattern, not once per row. Code quality matters more than token cost here.

## Extractor Runtime

Generated extractor code should be run against the first row, validated, and repaired if needed.

Once it passes, it can be applied across all rows.

The extractor returns JSON only. BigSet validates and writes to Convex.

Example extractor contract:

```ts
export async function extract({ page, input, helpers }) {
  await page.goto(input.product_url, { waitUntil: "domcontentloaded" });

  const title = await page.locator("#productTitle").textContent();
  const price = await page.locator(".a-price .a-offscreen").first().textContent();
  const rating = await page.locator("#acrPopover").getAttribute("title");

  return {
    data: {
      product_url: input.product_url,
      title: helpers.cleanText(title),
      price: helpers.parsePrice(price),
      star_rating: helpers.parseRating(rating),
    },
    sources: [page.url()],
    how_found: "Opened the product URL in TinyFish Browser and extracted fields from the rendered DOM.",
  };
}
```

## Security Stance

We do not need heavyweight Docker isolation for the MVP.

But generated code should not run inside the main backend process.

Minimum acceptable runtime boundary:

- Run generated code in a child Node process
- Empty environment
- No OpenRouter key
- No TinyFish API key
- No Convex admin key
- No keychain access
- No direct database writes
- Hard timeout
- Output-size limit
- Backend validates all returned data before writing

The generated script can control only a single TinyFish Browser session via Playwright.

Before execution, BigSet can reject obvious dangerous code patterns as defense-in-depth:

- `fs`
- `child_process`
- `worker_threads`
- `process.env`
- `require`
- dynamic import
- `eval`
- `new Function`
- `http` / `https` / `net`

This is not a perfect hostile-code sandbox, but it is enough for an MVP if no secrets are exposed and all writes go through backend validation.

## Failure / Roadblock Behavior

A codified extractor should stop or request repair when:

- Required selectors return empty
- Validation fails repeatedly
- Multiple consecutive rows fail
- The site layout differs from the first row
- The page is blocked or shows CAPTCHA/access-denied content
- Browser session times out

At that point BigSet can:

1. Send failure context back to the extractor-builder for repair
2. Fall back to TinyFish Agent for that row
3. Fall back to the existing LLM investigate flow
4. Mark the row as needing review

## Usage and Credits

TinyFish currently does not expose a documented credits-remaining endpoint.

For now BigSet can estimate usage:

- Search: free / no credits per current docs
- Fetch: free / no credits per current docs
- Agent: roughly `num_of_steps` credits
- Browser: roughly `ceil(duration_seconds / 240)` credits

When TinyFish exposes a credits/balance endpoint, BigSet can show real usage and remaining balance.

## Main Decision

BigSet should add a codification layer that compiles repeatable dataset extraction into reusable TinyFish Browser scripts.

LLMs should be used to:

- infer schemas
- decide if codification is possible
- generate or repair extractors
- handle ambiguous fallback cases

TinyFish Browser should be used to:

- execute repeatable extraction
- bypass bot detection
- render dynamic pages
- refresh data cheaply and reliably at scale

This improves data quality, reduces repeated OpenRouter token usage, and makes BigSet a stronger showcase for TinyFish subscriptions.
