import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { env } from "../env.js";
import { datasetSchemaSchema, type DatasetSchema } from "./types.js";

const MODEL = "claude-sonnet-4-6";
const TOOL_NAME = "emit_dataset_schema";

const SYSTEM_PROMPT = readFileSync(
  new URL("../../prompts/schema-inference.txt", import.meta.url),
  "utf8",
);

if (!env.ANTHROPIC_API_KEY) {
  throw new Error("Missing required environment variable: ANTHROPIC_API_KEY");
}

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const datasetSchemaInputSchema = {
  type: "object",
  required: [
    "dataset_name",
    "description",
    "columns",
    "primary_key",
    "retrieval_strategy",
    "source_hint",
  ],
  properties: {
    dataset_name: {
      type: "string",
      description: "snake_case identifier for the dataset",
    },
    description: {
      type: "string",
      description: "Human-readable summary of what this dataset captures",
    },
    primary_key: {
      type: "string",
      description: "Name of the column that uniquely identifies each row",
    },
    retrieval_strategy: {
      type: "string",
      enum: ["search_fetch", "browser", "hybrid"],
      description:
        "search_fetch for static pages, browser for SPAs/paginated UIs, hybrid if unclear",
    },
    source_hint: {
      type: "string",
      description:
        "Specific URL where the data can be found, or a precise description if no single URL exists",
    },
    columns: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "name",
          "display_name",
          "type",
          "is_primary_key",
          "is_enumerable",
          "retrieval_hint",
          "nullable",
        ],
        properties: {
          name: { type: "string", description: "snake_case column name" },
          display_name: { type: "string" },
          type: {
            type: "string",
            enum: ["string", "url", "date", "number", "boolean", "enum"],
          },
          is_primary_key: { type: "boolean" },
          is_enumerable: {
            type: "boolean",
            description:
              "true only on the primary key and any other columns whose values can be used to enumerate all rows",
          },
          retrieval_hint: {
            type: "string",
            description: "Where/how to find this column's value in Phase 3",
          },
          nullable: { type: "boolean" },
        },
      },
    },
  },
};

export async function inferSchema(prompt: string): Promise<DatasetSchema> {
  const first = await callOnce(prompt);
  const firstParsed = datasetSchemaSchema.safeParse(first);
  if (firstParsed.success) return firstParsed.data;

  const errorText = z.prettifyError(firstParsed.error);
  const retryMessage = `${prompt}\n\nYour previous output failed validation:\n${errorText}\n\nReturn a corrected DatasetSchema.`;
  const second = await callOnce(retryMessage);
  return datasetSchemaSchema.parse(second);
}

async function callOnce(userMessage: string): Promise<unknown> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Emit the inferred DatasetSchema describing the dataset to be built.",
        input_schema: datasetSchemaInputSchema as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userMessage }],
  });

  for (const block of response.content) {
    if (block.type === "tool_use") return block.input;
  }
  throw new Error("Model did not emit a tool_use block");
}
