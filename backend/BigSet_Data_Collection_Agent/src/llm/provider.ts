import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { config } from "../config.js";

let openRouterProvider: ReturnType<typeof createOpenRouter> | null = null;

function getOpenRouterProvider(): ReturnType<typeof createOpenRouter> {
  if (!openRouterProvider) {
    openRouterProvider = createOpenRouter({
      apiKey: config.openRouterApiKey,
      headers: {
        "HTTP-Referer": config.openRouterSiteUrl,
        "X-Title": config.openRouterAppName,
      },
    });
  }
  return openRouterProvider;
}

/** OpenRouter chat model via the official AI SDK provider (not OpenAI-compatible shim). */
export function getOpenRouterChatModel() {
  return getOpenRouterProvider().chat(config.openRouterModel);
}
