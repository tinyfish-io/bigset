import { readFileSync } from "node:fs";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { env } from "../env.js";
import { datasetSchemaSchema, type DatasetSchema } from "./types.js";

const SYSTEM_PROMPT = readFileSync(
  new URL("../../prompts/schema-inference.txt", import.meta.url),
  "utf8",
);

function getModel() {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
  }
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
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
