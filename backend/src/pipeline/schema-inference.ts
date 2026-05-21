import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { datasetSchemaSchema, type DatasetSchema } from "./types.js";

const SYSTEM_PROMPT = `You are a data engineering assistant that converts natural-language prompts into structured dataset schemas. Given a user prompt describing a dataset they want to build, you produce a precise schema definition.

Your job is to:

1. Identify the universe of entities the user wants to collect. Each entity becomes one row in the dataset.
2. Pick a clear primary key — the column whose values uniquely identify each row. This is usually a name, ID, or canonical URL. Exactly one column must have \`is_primary_key: true\`, and its \`name\` must equal \`primary_key\`. The primary key column must have \`nullable: false\` and \`is_enumerable: true\`.
3. Choose useful columns. Each column captures one fact about the entity. Use snake_case names. Mark \`is_enumerable: true\` only on columns whose values can be used to list all rows (typically just the primary key, and occasionally one or two others when a source page lists them alongside the primary key).
4. Set \`retrieval_strategy\`:
   - \`search_fetch\` — the data lives on a static page or sitemap that can be fetched as HTML.
   - \`browser\` — the source is a JavaScript-heavy SPA, requires scroll/click to reveal items, or paginates client-side.
   - \`hybrid\` — unclear; the pipeline will try search_fetch first and fall back to browser.
5. Set \`source_hint\` to a specific URL whenever possible (e.g. \`https://www.ycombinator.com/companies?industry=Fintech\`). Avoid vague descriptions.
6. Write a \`retrieval_hint\` for each column describing where/how the value can be found later. Downstream agents will use this to fill the column for each row.

Rules:

- \`dataset_name\` must be snake_case.
- All column \`name\` values must be snake_case and unique.
- Prefer concrete column choices over speculative ones — better to omit a column than guess wildly.`;

function getModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
  }
  const openrouter = createOpenRouter({ apiKey });
  return openrouter("anthropic/claude-sonnet-4-6");
}

export async function inferSchema(prompt: string): Promise<DatasetSchema> {
  const model = getModel();
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

async function callOnce(
  model: Parameters<typeof generateText>[0]["model"],
  prompt: string,
): Promise<DatasetSchema> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: datasetSchemaSchema }),
    system: SYSTEM_PROMPT,
    maxTokens: 4096,
    prompt,
  });
  if (!output) throw new Error("Model did not generate a valid schema object");
  return output;
}
