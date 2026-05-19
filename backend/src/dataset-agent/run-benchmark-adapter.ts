import "dotenv/config";

import { runDatasetAgentFromEnv } from "./index.js";

const prompt = requiredEnv("BIGSET_BENCHMARK_PROMPT");
const promptId = process.env.BIGSET_BENCHMARK_PROMPT_ID;
const promptQuality = process.env.BIGSET_BENCHMARK_PROMPT_QUALITY;
const requiredColumns = requiredEnv("BIGSET_BENCHMARK_REQUIRED_COLUMNS")
  .split(",")
  .map((columnName) => columnName.trim())
  .filter(Boolean);

const result = await runDatasetAgentFromEnv({
  prompt,
  promptId,
  promptQuality,
  requiredColumns,
});

console.log(JSON.stringify(result));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run through run-benchmark.mjs.`);
  }
  return value;
}
