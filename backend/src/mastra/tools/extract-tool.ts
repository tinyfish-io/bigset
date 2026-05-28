/**
 * extract-tool.ts — builds the `extract_pages` tool for the populate orchestrator.
 *
 * Unlike the investigate agent (which runs a full agent loop per entity),
 * this tool is a lightweight two-step programmatic call:
 *   1. Fetch the given URLs in parallel via executeFetchPage.
 *   2. Call a cheap/fast LLM once per page with generateObject to extract
 *      entities in structured format — no back-and-forth agent loop.
 *
 * The tool maintains a dedup set of entity primary-key composites in its
 * closure. Each call only returns entities that have NOT been returned
 * before, acting as the pointer that prevents the orchestrator from
 * dispatching duplicate investigate agents for the same entity.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { executeFetchPage } from "./web-tools.js";
import { env } from "../../env.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

// Per-page extraction output schema. Kept flat so the LLM has no trouble
// with nested objects.
const pageExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        primary_keys: z
          .record(z.string(), z.string())
          .describe("Primary key column values — required, must be non-empty"),
        partial_data: z
          .record(z.string(), z.string())
          .optional()
          .describe("Any other column values visible on the page"),
        hints: z
          .string()
          .optional()
          .describe(
            "Notes on where/how to find missing column values for this specific entity",
          ),
      }),
    )
    .describe("All matching entities found on this page"),
  leads: z
    .array(z.string())
    .describe(
      "URLs from this page likely to contain more matching entities (pagination, related directories, etc.)",
    ),
});

/**
 * Build the extract_pages tool scoped to one dataset schema.
 *
 * @param datasetName  Human-readable dataset name — given to the extract LLM
 * @param description  Dataset description — given to the extract LLM
 * @param columns      Column definitions (must include isPrimaryKey flags)
 *
 * Returns a Mastra tool. Build once per workflow run; do not share across runs
 * (the dedup set is per-run state captured in the closure).
 */
export function buildExtractTool(
  datasetName: string,
  description: string,
  columns: PopulateColumn[],
) {
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
  });

  const pkColumns = columns.filter((c) => c.isPrimaryKey);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  // Tracks primary-key composites already returned to the orchestrator.
  // Keyed as JSON-stringified sorted [colName, normalizedValue] pairs so
  // casing/whitespace differences don't produce spurious duplicates.
  const dispatchedKeys = new Set<string>();

  function makeEntityKey(primaryKeys: Record<string, string>): string {
    return JSON.stringify(
      pkColumns
        .map((c) => [c.name, (primaryKeys[c.name] ?? "").toLowerCase().trim()])
        .filter(([, v]) => v !== ""),
    );
  }

  const systemPrompt = `You extract structured entity data from web pages for a dataset.

Dataset: ${datasetName}${description ? `\nDescription: ${description}` : ""}

Target columns:
${columnsDesc}

For each matching entity on the page:
- Fill primary key column(s) (${pkColumns.map((c) => `"${c.name}"`).join(", ")}) — required.
- Fill any other column values that are clearly visible on the page.
- Add a hints field: short notes on where to find missing values for this entity (e.g. "check their LinkedIn profile for email").

Also return leads: URLs linked from this page that are likely to contain more matching entities (list pages, directories, pagination).

Only include entities that genuinely match the dataset topic. Do not fabricate values.`;

  return createTool({
    id: "extract_pages",
    description:
      "Fetch 1–5 web pages and extract all matching dataset entities from them using a fast LLM. Returns structured entity data (primary keys, partial column values, hints for missing fields) and leads (URLs with more entities). Only returns entities not yet dispatched to run_subagent — call this before run_subagent to populate your investigation queue.",
    inputSchema: z.object({
      urls: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("1–5 URLs to fetch and extract entities from"),
    }),
    outputSchema: z.object({
      entities: z.array(
        z.object({
          primary_keys: z.record(z.string(), z.string()),
          partial_data: z.record(z.string(), z.string()).optional(),
          hints: z.string().optional(),
          source_url: z.string(),
        }),
      ),
      leads: z.array(z.string()),
      errors: z.array(z.string()).optional(),
    }),
    execute: async ({ urls }) => {
      console.log(
        `[extract_pages] Fetching ${urls.length} URL(s): ${urls.join(", ")}`,
      );

      // Step 1: fetch all pages in parallel
      const fetched = await Promise.all(
        urls.map(async (url) => ({ url, page: await executeFetchPage(url) })),
      );

      const newEntities: Array<{
        primary_keys: Record<string, string>;
        partial_data?: Record<string, string>;
        hints?: string;
        source_url: string;
      }> = [];
      const allLeads: string[] = [];
      const errors: string[] = [];

      // Step 2: run LLM extraction on each successfully fetched page in parallel
      await Promise.all(
        fetched.map(async ({ url, page }) => {
          if (page.error || !page.text) {
            errors.push(`${url}: ${page.error ?? "no content"}`);
            return;
          }

          try {
            const { object } = await generateObject({
              model: openrouter(env.BIGSET_EXTRACT_MODEL),
              schema: pageExtractionSchema,
              system: systemPrompt,
              prompt: `Page URL: ${url}${page.title ? `\nPage title: ${page.title}` : ""}\n\n${page.text}`,
            });

            let pageNewCount = 0;
            for (const entity of object.entities) {
              // Skip entities with no primary key values
              const hasPk = pkColumns.some(
                (c) => entity.primary_keys[c.name]?.trim(),
              );
              if (!hasPk) continue;

              // Dedup: only pass through entities the orchestrator hasn't seen
              const key = makeEntityKey(entity.primary_keys);
              if (!dispatchedKeys.has(key)) {
                dispatchedKeys.add(key);
                newEntities.push({ ...entity, source_url: url });
                pageNewCount++;
              }
            }

            allLeads.push(...object.leads);
            console.log(
              `[extract_pages] ${url}: ${object.entities.length} found, ${pageNewCount} new`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[extract_pages] LLM extraction failed for ${url}: ${msg}`,
            );
            errors.push(`${url}: extraction failed`);
          }
        }),
      );

      const dedupedLeads = [...new Set(allLeads)];
      console.log(
        `[extract_pages] Done: ${newEntities.length} new entities total, ${dedupedLeads.length} leads`,
      );
      return {
        entities: newEntities,
        leads: dedupedLeads,
        ...(errors.length > 0 ? { errors } : {}),
      };
    },
  });
}
