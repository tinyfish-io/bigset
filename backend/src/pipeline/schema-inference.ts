import { generateText, Output, NoObjectGeneratedError } from "ai";

import { DEFAULT_MODEL_IDS } from "../config/models.js";
import { createLanguageModel } from "../config/llm.js";
import { requireLlmProviderConfig } from "../local-credentials.js";
import {
  datasetSchemaSchema,
  type ColumnDefinition,
  type DatasetSchema,
  type RetrievalStrategy,
} from "./types.js";

const SYSTEM_PROMPT = `You are a data engineering assistant that converts natural-language prompts into structured dataset schemas. Given a user prompt describing a dataset they want to build, you produce a precise schema definition.

Your job is to:

1. Identify the universe of entities the user wants to collect. Each entity becomes one row in the dataset.
2. Pick primary key column(s) — one or more columns whose combined values uniquely identify each row (no two legitimate rows should share the same values across all primary key columns in any case). Refrain from names unless necessary, as they may not always be unqiue (unless this is guarenteed). Otherwise use thigns like URLs or IDs that have a 100% guarentee of being unique. Set \`is_primary_key: true\` on each primary key column. Set \`primary_key\` to an array of primary key column names; use a one-item array for a single primary key. Every primary key column must have \`nullable: false\` and \`is_enumerable: true\`. Prefer a single column when one naturally uniquely identifies each row.
3. Choose useful columns. Each column captures one fact about the entity. Use snake_case names. Mark \`is_enumerable: true\` only on columns whose values can be used to list all rows (typically just the primary key, and occasionally one or two others when a source page lists them alongside the primary key).
4. Set \`retrieval_strategy\`:
   - \`search_fetch\` — the data lives on a static page or sitemap that can be fetched as HTML.
   - \`browser\` — the source is a JavaScript-heavy SPA, requires scroll/click to reveal items, or paginates client-side.
   - \`hybrid\` — unclear; the pipeline will try search_fetch first and fall back to browser.
5. Set \`source_hint\` to a specific URL whenever possible (e.g. \`https://www.ycombinator.com/companies?industry=Fintech\`). Avoid vague descriptions.
6. Write a \`retrieval_hint\` for each column describing where/how the value can be found later. Downstream agents will use this to fill the column for each row.
7. For each column where a value has a known shape, include \`validation_regex\` and \`normalization_hint\`. These are extractor contracts, not UI decoration. Examples: ratings, prices, dates, URL/slug shapes, repository slugs, app package names, counts, currencies, availability labels. Omit \`validation_regex\` only when the value is genuinely free-form text.
8. Set \`codification_profile\`. This is a cheap schema-time decision about whether BigSet should attempt to compile a reusable Playwright extractor later.
   - \`mode: "disabled"\` when rows will come from broad web search, arbitrary unrelated domains, or search snippets with no stable page family.
   - \`mode: "candidate"\` when rows likely share one or more stable page families and a reusable browser script may work after seeing a representative row.
   - Use \`mode: "candidate"\`, not \`disabled\`, when the only concern is that the stable source has anti-bot or automation-blocking reputation. BigSet uses TinyFish Browser for interactive browser access, and TinyFish can often get through surfaces that plain fetches or commodity browser automation cannot. The extractor builder will inspect a real page and decline if it is actually blocked.
   - \`mode: "required"\` when the dataset is clearly tied to one authoritative browser-heavy source or directory where repeated extraction is the intended path.
   - \`mode: "unknown"\` only when the prompt/schema gives too little evidence; prefer \`disabled\` over \`unknown\` for broad web datasets to avoid expensive extractor attempts.
   Include \`primary_key_shape\` as one of \`url\`, \`slug\`, \`name\`, \`id\`, \`mixed\`, or \`unknown\`. Include \`families\` for known source/page families. Use snake_case labels. For URL templates, use column placeholders like \`https://github.com/{repo_slug}\`.

Rules:

- Keep it simple. Include only 4-6 columns — the essentials someone would put in a quick spreadsheet for this topic. Do not add niche, speculative, or hard-to-find columns.
- \`dataset_name\` must be snake_case.
- All column \`name\` values must be snake_case and unique.
- Prefer concrete column choices over speculative ones — better to omit a column than guess wildly.
- Validation regexes must validate the normalized final value, not raw page text. Keep them practical and anchored, e.g. "^[0-5](\\\\.\\\\d)?$" for a normalized rating or "^[^/\\\\s]+/[^/\\\\s]+$" for an owner/repo slug.
- \`normalization_hint\` should tell the extractor how to convert raw page text into the stored value, e.g. "Convert '4.6 out of 5 stars' to '4.6'" or "Strip commas and convert 1.2k to 1200".
- \`codification_profile\` should be conservative. Do not mark arbitrary company/person/place/product research as codifiable just because pages exist on the web. Mark it codifiable only when rows can be routed to stable page families from the primary key, source_hint, or obvious URL templates.
- For marketplace/catalog identifiers with deterministic product pages, prefer a URL-template family over disabling codification. Use the site/schema's actual identifier and route shape; do not hardcode a source-specific template unless it is implied by the user prompt or discovered source hint.
- When a column is a scalar numeric rating (e.g. average score like 4.3/5 for restaurants, cafes, hotels, products, apps): name it generically (e.g. "rating" not "yelp_rating") and write a retrieval_hint explaining that review sites (Yelp, TripAdvisor, Google Maps) block direct page fetches, so the agent must extract ratings from **search result snippets**. The hint should say: "Search for \\"<entity name> rating reviews\\" and include location terms only when location is part of the entity identity. Look for ratings in snippets from TripAdvisor (\\"rated X.X of 5\\"), Yelp search listings (\\"X.X (N reviews)\\"), or aggregator sites (Birdeye, joe.coffee, giftly, Uber Eats, menufyy). Do NOT try to fetch yelp.com or tripadvisor.com directly — they block automated access. Accept ratings from any reputable source." If including a rating column, also add a "rating_source" text column so the agent records where the rating came from. Do not rename review-count or review-text fields to "rating" — keep those as distinct columns (e.g. "review_count") when the user explicitly asks for them.`;

export interface FinalizeSchemaColumnInput {
  name: string;
  type: ColumnDefinition["type"];
  description?: string;
  isPrimaryKey?: boolean;
}

export interface FinalizeSchemaInput {
  prompt: string;
  datasetName?: string;
  columns: FinalizeSchemaColumnInput[];
  retrievalStrategy?: RetrievalStrategy;
  sourceHint?: string;
}

async function getModel(modelSlug?: string) {
  const config = await requireLlmProviderConfig();
  const resolvedSlug = modelSlug ?? config.defaultModel ?? DEFAULT_MODEL_IDS.SCHEMA_INFERENCE;
  return createLanguageModel(config, resolvedSlug);
}

export async function inferSchema(prompt: string, modelSlug?: string): Promise<DatasetSchema> {
  const model = await getModel(modelSlug);
  return await generateSchema(model, prompt);
}

export async function finalizeSchemaContracts(
  input: FinalizeSchemaInput,
  modelSlug?: string,
): Promise<DatasetSchema> {
  const model = await getModel(modelSlug);
  return await generateSchema(model, buildFinalizePrompt(input));
}

async function generateSchema(
  model: Parameters<typeof generateText>[0]["model"],
  prompt: string,
): Promise<DatasetSchema> {
  try {
    return await callOnce(model, prompt);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const detail = error.cause ? String(error.cause) : error.text;
      const retry = `${prompt}\n\nYour previous output failed validation:\n${detail}\n\nReturn a corrected DatasetSchema.`;
      return await callOnce(model, retry);
    }
    throw error;
  }
}

function buildFinalizePrompt(input: FinalizeSchemaInput): string {
  const columns = input.columns
    .map((column, index) => {
      const primaryKey = column.isPrimaryKey ? "yes" : "no";
      const description = column.description?.trim() || "(none)";
      return `${index + 1}. visible_name=${JSON.stringify(column.name)} type=${column.type} primary_key=${primaryKey} description=${JSON.stringify(description)}`;
    })
    .join("\n");

  return `Refresh the hidden extraction contracts for this final, user-reviewed dataset schema.

Original user request:
${input.prompt}

Final dataset display name:
${input.datasetName?.trim() || "(not provided)"}

Final visible columns:
${columns}

Current retrieval strategy: ${input.retrievalStrategy ?? "(not set)"}
Current source hint: ${input.sourceHint?.trim() || "(not set)"}

Return a complete DatasetSchema for the final visible schema above.

Rules for this refresh:
- Do not add, remove, split, or reorder columns. Return exactly ${input.columns.length} columns in the same order.
- Preserve each column's type and visible meaning. Use a snake_case "name" derived from visible_name only because DatasetSchema requires it.
- Keep primary_key flags as provided unless no column is marked primary_key=yes; in that case choose the best primary key from the final columns.
- Use each visible description as the basis for retrieval_hint, refining only to clarify how to extract that same value.
- Regenerate nullable, validation_regex, normalization_hint, source_hint, retrieval_strategy, and codification_profile from this final schema.
- Include validation_regex for shaped values where it adds real validation value. Omit validation_regex for genuinely free-form text instead of emitting a catch-all regex.
- validation_regex must validate the normalized final stored value, not raw page text.`;
}

async function callOnce(
  model: Parameters<typeof generateText>[0]["model"],
  prompt: string,
): Promise<DatasetSchema> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: datasetSchemaSchema }),
    system: SYSTEM_PROMPT,
    maxOutputTokens: 5000,
    prompt,
  });
  if (!output) throw new Error("Model did not generate a valid schema object");
  return output;
}
