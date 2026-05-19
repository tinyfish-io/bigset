import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { inferSchema } from "./pipeline/schema-inference.js";

function parsePrompt(argv: string[]): string {
  const idx = argv.findIndex((a) => a === "--prompt");
  if (idx === -1 || idx === argv.length - 1) {
    throw new Error('Usage: npm run infer-schema -- --prompt "<your prompt>"');
  }
  const value = argv[idx + 1];
  if (!value.trim()) throw new Error("--prompt requires a non-empty value");
  return value;
}

function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = randomBytes(3).toString("hex");
  return `${ts}-${rand}`;
}

async function main() {
  const prompt = parsePrompt(process.argv.slice(2));
  const runId = generateRunId();
  const outDir = join("output", runId);

  console.log(`Inferring schema for: "${prompt}"`);
  const schema = await inferSchema(prompt);

  mkdirSync(outDir, { recursive: true });
  const schemaPath = join(outDir, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + "\n");

  console.log(`Run ID: ${runId}`);
  console.log(`Schema: backend/${schemaPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
