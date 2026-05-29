/**
 * extract-tool.ts — builds the `extract_pages` tool for the populate orchestrator.
 *
 * Unlike the investigate agent (which runs a full agent loop per entity),
 * this tool is a lightweight two-step programmatic call:
 *   1. Fetch the given URLs in parallel via executeFetchPage.
 *   2. Call a cheap/fast LLM once per page with generateObject to extract
 *      entities in structured format — no back-and-forth agent loop.
 *
 * Deduplication strategy
 * ─────────────────────
 * The tool maintains a per-run dedup set in its closure. Dedup uses OR
 * logic across all primary key columns: for each entity, one key is
 * stored per found PK column value (`${colName}:${normalizedValue}`).
 * An entity is skipped if ANY of its PK column keys is already in the
 * set. When dispatched, ALL found PK column keys are added to the set.
 *
 * Schema inference always produces at least a human-readable name column
 * as a PK (always visible on listing pages) and optionally a URL/ID column.
 * The entity name PK is required — entities without it are skipped.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { executeFetchPage } from "./web-tools.js";
import { env } from "../../env.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

// Per-page extraction output schema.
// primary_keys should always include the entity name PK (always visible on
// listing pages). URL/ID PK is filled if directly visible; omit otherwise.
const pageExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        primary_keys: z
          .record(z.string(), z.string())
          .describe(
            "Primary key column values found on the page. The entity name column MUST always be filled — it is always visible on listing pages. Fill URL/ID columns only if the value is directly visible on the page; omit them if not shown.",
          ),
        partial_data: z
          .record(z.string(), z.string())
          .optional()
          .describe("Any other column values visible on the page"),
        hints: z
          .string()
          .optional()
          .describe(
            "Notes on where/how to find missing column values for this entity (e.g. 'check their LinkedIn for email', 'homepage footer has the address')",
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

  // Per-run dedup set. One entry per non-empty primary_keys value returned
  // by the extract LLM. Key format: `${fieldName}:${normalizedValue}`.
  // An entity is a duplicate if ANY of its keys is already present (OR logic).
  // All keys are added when an entity is dispatched.
  //
  // Note: we use ALL non-empty values the LLM returns in primary_keys,
  // not just the ones matching pkColumns by name. This handles:
  //   - Old schemas with URL-only PK (LLM still returns whatever it finds)
  //   - New compound PK schemas (entity name always present)
  //   - Mild LLM key-name drift (e.g. "url" vs "company_url")
  // The authoritative duplicate check at insert time (Convex OR-dedup on
  // the actual pkColumns) is the final guard; this set only prevents
  // double-dispatching the same entity to run_subagent within one run.
  const dispatchedKeys = new Set<string>();

  function makePkKeys(primaryKeys: Record<string, string>): string[] {
    return Object.entries(primaryKeys)
      .filter(([, v]) => v.toLowerCase().trim() !== "")
      .map(([k, v]) => `${k}:${v.toLowerCase().trim()}`);
  }

  function isAlreadyDispatched(keys: string[]): boolean {
    return keys.some((k) => dispatchedKeys.has(k));
  }

  function recordDispatched(keys: string[]): void {
    for (const k of keys) dispatchedKeys.add(k);
  }

  const pkNames = pkColumns.map((c) => `"${c.name}"`).join(", ");
  const systemPrompt = `You extract structured entity data from web pages for a dataset.

Dataset: ${datasetName}${description ? `\nDescription: ${description}` : ""}

Target columns:
${columnsDesc}

For each matching entity on the page:
- Fill primary_keys (${pkNames}). The entity name column MUST always be filled — entity names are always visible on listing pages. Fill URL/ID columns only if the value is directly visible; omit them entirely if not shown on the page. Do NOT guess or fabricate values.
- Fill partial_data with any other column values visible on the page.
- Fill hints with short notes on where to find missing values for this entity.

Also return leads: URLs from this page likely to contain more matching entities.

Only include entities that genuinely match the dataset topic. Do not fabricate values.`;

  return createTool({
    id: "extract_pages",
    description:
      "Fetch 1–5 web pages and extract all matching dataset entities from them using a fast LLM. Returns structured entity data (primary keys including entity name, partial column values, hints for missing fields) and leads (URLs with more entities). Only returns entities not yet dispatched to run_subagent.",
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
              // Require at least one PK column value (entity name is always filled)
              const pkKeys = makePkKeys(entity.primary_keys ?? {});
              if (pkKeys.length === 0) continue;

              if (!isAlreadyDispatched(pkKeys)) {
                recordDispatched(pkKeys);
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
