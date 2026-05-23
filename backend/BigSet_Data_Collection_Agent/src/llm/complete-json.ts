import { generateText, Output } from "ai";
import type { z } from "zod";

import { config } from "../config.js";
import { getOpenRouterLimiter } from "../queue/pools.js";
import { getOpenRouterChatModel } from "./provider.js";
import { recordLanguageModelUsage } from "./usage.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

function splitPromptMessages(messages: LlmMessage[]): {
  system?: string;
  messages: ConversationMessage[];
} {
  const systemParts: string[] = [];
  const conversation: ConversationMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    conversation.push({ role: message.role, content: message.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: conversation,
  };
}

/**
 * Structured JSON completion via Vercel AI SDK (`generateText` + `Output.object`).
 * Token usage is recorded into the current `runWithLlmUsageScope` when active.
 */
export async function completeJson<T>(options: {
  messages: LlmMessage[];
  schema: z.ZodType<T>;
  label: string;
  maxRetries?: number;
}): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  let messages = [...options.messages];
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await getOpenRouterLimiter().acquire();

    const { system, messages: conversation } = splitPromptMessages(messages);

    try {
      const result = await generateText({
        model: getOpenRouterChatModel(),
        ...(system ? { system } : {}),
        messages: conversation,
        output: Output.object({ schema: options.schema }),
        ...(config.openRouterTemperature !== undefined
          ? { temperature: config.openRouterTemperature }
          : {}),
      });

      recordLanguageModelUsage(result.usage);
      return result.output as T;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        messages = [
          ...messages,
          {
            role: "user",
            content: `Your JSON was invalid for ${options.label}. Error: ${
              error instanceof Error ? error.message : String(error)
            }. Return only valid JSON matching the requested schema.`,
          },
        ];
      }
    }
  }

  throw new Error(
    `${options.label} failed after ${maxRetries + 1} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
