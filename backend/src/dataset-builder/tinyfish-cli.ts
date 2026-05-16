import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TinyFishSearchOptions {
  query: string;
  location?: string;
  language?: string;
}

export interface TinyFishAgentRunOptions {
  goal: string;
  url?: string;
  outputSchema?: unknown;
  maxSteps?: number;
}

export async function runTinyFishSearch(options: TinyFishSearchOptions) {
  const args = ["search", "query", options.query];
  if (options.location) {
    args.push("--location", options.location);
  }
  if (options.language) {
    args.push("--language", options.language);
  }

  return runTinyFishJson(args);
}

export async function runTinyFishFetch(urls: string[]) {
  return runTinyFishJson(["fetch", "content", "get", ...urls]);
}

export async function runTinyFishAgent(options: TinyFishAgentRunOptions) {
  const args = ["agent", "run", "--sync"];

  if (options.url) {
    args.push("--url", options.url);
  }
  if (options.maxSteps) {
    args.push("--max-steps", String(options.maxSteps));
  }
  if (options.outputSchema) {
    args.push("--output-schema", JSON.stringify(options.outputSchema));
  }

  args.push(options.goal);

  return runTinyFishJson(args);
}

async function runTinyFishJson(args: string[]) {
  const { stdout } = await execFileAsync("tinyfish", args, {
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });

  return JSON.parse(stdout) as unknown;
}
