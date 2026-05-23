import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
  SCHEMA_INFERENCE_OPENROUTER_MODEL_ID,
  requiredOpenRouterApiKey,
} from "../openrouter-models.js";
import { recordLanguageModelUsage } from "./llm-usage.js";
import { datasetSchemaSchema, type DatasetSchema } from "./types.js";

export interface InferSchemaOptions {
  searchQueryCount?: number;
}

export function resolveInitialSearchQueryCap(maxSearchCalls: number): number {
  return Math.max(1, Math.floor(maxSearchCalls / 2));
}

function initialQueriesFromDataSpec(
  dataSpec: DatasetSchema,
  expectedCount: number
): string[] {
  const queries = dataSpec.search_queries
    .map((query) => query.trim())
    .filter(Boolean);
  if (queries.length !== expectedCount) {
    throw new Error(
      `Data spec must include exactly ${expectedCount} search_queries (got ${queries.length}).`
    );
  }
  return queries;
}

export async function resolvePopulateDataSpec(input: {
  prompt: string;
  dataSpec?: DatasetSchema;
  maxSearchCalls: number;
  inferSchemaFn?: typeof inferSchema;
}): Promise<{ dataSpec: DatasetSchema; initialQueries: string[] }> {
  const expectedQueryCount = resolveInitialSearchQueryCap(input.maxSearchCalls);
  const infer = input.inferSchemaFn ?? inferSchema;
  let dataSpec = input.dataSpec;

  if (!dataSpec || dataSpec.search_queries.length !== expectedQueryCount) {
    dataSpec = await infer(input.prompt, {
      searchQueryCount: expectedQueryCount,
    });
  }

  return {
    dataSpec,
    initialQueries: initialQueriesFromDataSpec(dataSpec, expectedQueryCount),
  };
}

function buildSystemPrompt(searchQueryCount?: number): string {
  const searchQueryRule =
    searchQueryCount === undefined
      ? "Provide a diverse `search_queries` array (at least one) of web search strings to discover source pages for this dataset. Each query must be distinct and tailored to the user prompt and columns."
      : `Provide exactly ${searchQueryCount} items in \`search_queries\`: diverse, non-overlapping web search strings to discover source pages for this dataset. Each query must be distinct, specific to the user prompt and columns, and use site: operators when a domain is obvious. Do not return fewer or more than ${searchQueryCount} queries.`;

  return `You are a data engineering assistant that converts natural-language prompts into structured dataset schemas. Given a user prompt describing a dataset they want to build, you produce a precise schema definition.

Your job is to:

1. Identify the universe of entities the user wants to collect. Each entity becomes one row in the dataset.
2. Pick a clear primary key — the column whose values uniquely identify each row. This is usually a name, ID, or canonical URL. Exactly one column must have \`is_primary_key: true\`, and its \`name\` must equal \`primary_key\`. The primary key column must have \`nullable: false\` and \`is_enumerable: true\`.
3. Infer columns from the user prompt — include the facts they asked for as columns. Use snake_case names. Mark \`is_enumerable: true\` only on columns whose values can be used to list all rows (typically just the primary key, and occasionally one or two others when a source page lists them alongside the primary key).
4. Write a short \`description\` for each column explaining what the column represents (not where to find the value on the web).
5. ${searchQueryRule}

Do not set retrieval strategy or source URLs — search and fetch decisions happen later after results are available.

Rules:

- \`dataset_name\` must be snake_case.
- All column \`name\` values must be snake_case and unique.
- Prefer concrete column choices over speculative ones — better to omit a column than guess wildly.`;
}

function outputSchemaForOptions(options?: InferSchemaOptions) {
  const expectedCount = options?.searchQueryCount;
  if (expectedCount === undefined) {
    return datasetSchemaSchema;
  }

  return datasetSchemaSchema.superRefine((data, ctx) => {
    if (data.search_queries.length !== expectedCount) {
      ctx.addIssue({
        code: "custom",
        message: `search_queries must contain exactly ${expectedCount} items`,
        path: ["search_queries"],
      });
    }
  });
}

export async function inferSchema(
  prompt: string,
  options?: InferSchemaOptions
): Promise<DatasetSchema> {
  const model = createOpenRouter({ apiKey: requiredOpenRouterApiKey() })(
    SCHEMA_INFERENCE_OPENROUTER_MODEL_ID
  );
  try {
    return await callOnce(model, prompt, options);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const detail = error.cause ? String(error.cause) : error.text;
      const retry = `${prompt}\n\nYour previous output failed validation:\n${detail}\n\nReturn a corrected DatasetSchema.`;
      return await callOnce(model, retry, options);
    }
    throw error;
  }
}

async function callOnce(
  model: Parameters<typeof generateText>[0]["model"],
  prompt: string,
  options?: InferSchemaOptions
): Promise<DatasetSchema> {
  const schema = outputSchemaForOptions(options);
  const result = await generateText({
    model,
    output: Output.object({ schema }),
    system: buildSystemPrompt(options?.searchQueryCount),
    maxOutputTokens: 4096,
    prompt,
  });
  recordLanguageModelUsage(result.usage);
  const { output } = result;
  if (!output) {
    throw new Error("Model did not generate a valid schema object");
  }
  return output;
}
