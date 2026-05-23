import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelUsage } from "ai";

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

/** Run pipeline (or other work) with a scoped LLM usage accumulator. */
export async function runWithLlmUsageScope<T>(
  fn: () => Promise<T>,
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

export function toDatasetAgentUsage(
  usage: LlmUsageTotals,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}
