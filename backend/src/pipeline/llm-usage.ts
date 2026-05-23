import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelUsage } from "ai";

/** Internal LLM usage totals (benchmarking / diagnostics only). */
export interface LlmUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
}

const storage = new AsyncLocalStorage<LlmUsageTotals>();

export function emptyLlmUsage(): LlmUsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0,
  };
}

export async function runWithLlmUsageScope<T>(
  fn: () => Promise<T>
): Promise<{ result: T; usage: LlmUsageTotals }> {
  const usage = emptyLlmUsage();
  const result = await storage.run(usage, fn);
  return { result, usage: { ...usage } };
}

export function getCurrentLlmUsage(): LlmUsageTotals {
  return storage.getStore() ?? emptyLlmUsage();
}

export function recordLanguageModelUsage(usage: LanguageModelUsage | undefined): void {
  const totals = storage.getStore();
  if (!totals || !usage) {
    return;
  }

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  totals.promptTokens += promptTokens;
  totals.completionTokens += completionTokens;
  totals.totalTokens += usage.totalTokens ?? promptTokens + completionTokens;
  totals.callCount += 1;
}

export function recordAgentGenerationUsage(agentOutput: unknown): void {
  if (typeof agentOutput !== "object" || agentOutput === null) {
    return;
  }

  const record = agentOutput as Record<string, unknown>;
  const directUsage = record.usage;
  if (directUsage && typeof directUsage === "object") {
    recordLanguageModelUsage(directUsage as LanguageModelUsage);
    return;
  }

  const totalUsage = record.totalUsage;
  if (totalUsage && typeof totalUsage === "object") {
    recordLanguageModelUsage(totalUsage as LanguageModelUsage);
  }
}

export function toPopulateRuntimeUsage(
  usage: LlmUsageTotals
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}
