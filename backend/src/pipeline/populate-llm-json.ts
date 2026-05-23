import { generateText, Output } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { z } from "zod";

import {
  DEFAULT_OPENROUTER_MODEL_ID,
  requiredOpenRouterApiKey,
} from "../openrouter-models.js";
import { recordLanguageModelUsage } from "./llm-usage.js";

export async function completePopulateJson<T extends z.ZodType>(input: {
  label: string;
  schema: T;
  system: string;
  user: string;
}): Promise<z.infer<T>> {
  const model = createOpenRouter({ apiKey: requiredOpenRouterApiKey() })(
    DEFAULT_OPENROUTER_MODEL_ID
  );
  const result = await generateText({
    model,
    output: Output.object({ schema: input.schema }),
    system: input.system,
    prompt: input.user,
    maxOutputTokens: 8192,
  });
  recordLanguageModelUsage(result.usage);
  if (!result.output) {
    throw new Error(`${input.label}: model did not return structured output`);
  }
  return result.output;
}
