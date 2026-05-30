import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { datasetContextSchema, populateColumnSchema } from "../../pipeline/populate.js";
import { convex, internal } from "../../convex.js";
import { authContextSchema, buildPromptOutputSchema, agentStep } from "./populate.js";

export const appendInputSchema = datasetContextSchema.extend({
  authContext: authContextSchema,
});
export type AppendInput = z.infer<typeof appendInputSchema>;

// Extends the base input with prior-run context extracted from existing rows.
const appendContextSchema = appendInputSchema.extend({
  priorRowCount: z.number(),
  // Existing PK tuples — front-loaded in the orchestrator prompt so it skips
  // already-collected entities instead of wasting quota on subagent launches
  // that would be rejected by the DB-level dedup anyway.
  priorPkValues: z.array(z.record(z.string(), z.string())),
  // Up to 5 howFound strings sampled from existing rows. These are step-by-step
  // playbooks written by previous investigate subagents describing which URLs to
  // fetch and which fields to look for — exactly the patterns the new run needs
  // to reuse for finding more entities of the same type.
  howFoundSamples: z.array(z.string()),
});

const appendEnumerationOutputSchema = appendContextSchema.extend({
  enumerationStrategy: z.enum(["scraper", "search"]),
  manifest: z.array(z.record(z.string(), z.string())),
  sourceUrl: z.string().optional(),
});

/**
 * Fetch existing rows and extract two kinds of reusable intelligence:
 *   1. PK blocklist — tells the orchestrator which entities already exist so it
 *      doesn't spin up subagents for them (saves quota; dedup fires at insert
 *      time anyway, but dispatching a subagent only to have it rejected wastes
 *      several agent steps and tokens).
 *   2. howFound samples — step-by-step playbooks left by previous investigate
 *      subagents. The update workflow uses these to re-verify existing rows;
 *      here we repurpose them to teach the orchestrator which sources and
 *      extraction patterns work for this dataset type, so it can find more
 *      entities using the same approach.
 */
const buildContextStep = createStep({
  id: "build-context",
  inputSchema: appendInputSchema,
  outputSchema: appendContextSchema,
  execute: async ({ inputData }) => {
    console.log(`[build-context] Fetching existing rows for dataset ${inputData.datasetId}`);

    const rawRows = await convex.query(internal.datasetRows.listInternal, {
      datasetId: inputData.datasetId,
    });

    const rows = rawRows as Array<{
      data?: Record<string, unknown>;
      howFound?: string;
    }>;

    const pkColumns = inputData.columns.filter((c) => c.isPrimaryKey);

    // Extract PK tuples from every existing row.
    const priorPkValues: Record<string, string>[] = rows
      .map((r) => {
        const entry: Record<string, string> = {};
        for (const pk of pkColumns) {
          const val = r.data?.[pk.name];
          if (val !== undefined && val !== "") entry[pk.name] = String(val);
        }
        return entry;
      })
      .filter((e) => Object.keys(e).length > 0);

    // Sample up to 5 distinct non-empty howFound strings.
    const seen = new Set<string>();
    const howFoundSamples: string[] = [];
    for (const r of rows) {
      if (r.howFound && r.howFound.trim() && !seen.has(r.howFound)) {
        seen.add(r.howFound);
        howFoundSamples.push(r.howFound);
        if (howFoundSamples.length >= 5) break;
      }
    }

    console.log(
      `[build-context] Found ${rows.length} existing rows, ${priorPkValues.length} PK entries, ${howFoundSamples.length} howFound samples`,
    );

    return {
      ...inputData,
      priorRowCount: rows.length,
      priorPkValues,
      howFoundSamples,
    };
  },
});

/**
 * Same enumeration logic as populate's enumerateStep, but carries the prior
 * context fields forward through the schema so buildPromptStep can use them.
 */
const enumerateStep = createStep({
  id: "enumerate",
  inputSchema: appendContextSchema,
  outputSchema: appendEnumerationOutputSchema,
  execute: async ({ inputData }) => {
    console.log(`[enumerate] Classifying dataset ${inputData.datasetId}`);

    const dataset = await convex.query(internal.datasets.getInternal, {
      id: inputData.datasetId,
    });

    const retrievalStrategy =
      (dataset as Record<string, unknown>)?.retrievalStrategy as string ?? "search_fetch";
    const sourceHint =
      (dataset as Record<string, unknown>)?.sourceHint as string ?? "";

    const pkColumns = inputData.columns.filter((c) => c.isPrimaryKey);
    const columnsDesc = inputData.columns
      .map(
        (c) =>
          `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PK]" : ""}${c.description ? `: ${c.description}` : ""}`,
      )
      .join("\n");

    const classificationPrompt = `You are classifying a dataset's enumeration strategy.

Dataset: ${inputData.datasetName}
Description: ${inputData.description}
Retrieval strategy hint: ${retrievalStrategy}
Source hint: ${sourceHint}
Primary key columns: ${pkColumns.map((c) => c.name).join(", ") || "none"}

Columns:
${columnsDesc}

Can ALL primary key values for this dataset be enumerated from a single source URL (a directory page, registry, listing, catalog, or API)?

Answer "scraper" if yes — a single source lists all entities (e.g. YC company directory, Wikipedia list pages, product catalogs, government registries).
Answer "search" if no — entities must be discovered through broad web searches with no single authoritative listing.

Respond with EXACTLY one word: scraper or search`;

    let classification: "scraper" | "search" = "search";
    try {
      const openrouter = createOpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY!,
      });
      const result = await generateText({
        model: openrouter("anthropic/claude-sonnet-4-6"),
        prompt: classificationPrompt,
        maxOutputTokens: 10,
      });
      const answer = result.text.trim().toLowerCase();
      if (answer === "scraper" || answer === "search") {
        classification = answer;
      } else {
        console.warn(`[enumerate] Unexpected classification "${answer}", defaulting to "search"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enumerate] Classification failed: ${msg}, defaulting to "search"`);
    }

    if (classification === "scraper") {
      console.log(
        `[enumerate] Classified as SCRAPER (source: ${sourceHint}). Stub: empty manifest, falling through to search.`,
      );
    } else {
      console.log(`[enumerate] Classified as SEARCH. Proceeding with fan-out.`);
    }

    return {
      ...inputData,
      enumerationStrategy: classification,
      manifest: [],
      sourceUrl: classification === "scraper" ? sourceHint || undefined : undefined,
    };
  },
});

/**
 * Build the orchestrator prompt, enhanced with two sections drawn from the
 * prior-run context when the dataset already has rows:
 *
 *   ALREADY IN DATASET — the PK blocklist, so the orchestrator skips entities
 *   that are already covered and dispatches subagents only for genuinely new leads.
 *
 *   PROVEN SEARCH PATTERNS — howFound samples from previous investigate subagents.
 *   These are the same step-by-step playbooks the update workflow's refresh agent
 *   follows to re-verify existing rows. For append we repurpose them to seed the
 *   orchestrator's search strategy: "here's what worked last time, use the same
 *   approach to find more entities."
 *
 * When the dataset is empty both sections are omitted and the prompt is identical
 * to what the regular populate workflow produces.
 */
const buildPromptStep = createStep({
  id: "build-prompt",
  inputSchema: appendEnumerationOutputSchema,
  outputSchema: buildPromptOutputSchema,
  execute: async ({ inputData }) => {
    const pkColumns = inputData.columns.filter((c) => c.isPrimaryKey);
    const columnsDesc = inputData.columns
      .map(
        (c) =>
          `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.description ? `: ${c.description}` : ""}`,
      )
      .join("\n");

    const pkNote =
      pkColumns.length > 0
        ? `\nPrimary key column(s): ${pkColumns.map((c) => `"${c.name}"`).join(", ")}. When calling run_subagent, you MUST pass these values in the primary_keys field. The subagent will research and fill in the remaining columns.`
        : "";

    let manifestNote = "";
    if (inputData.manifest.length > 0) {
      const manifestList = inputData.manifest
        .map((entry) =>
          Object.entries(entry)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", "),
        )
        .join("\n  - ");
      manifestNote = `\n\nPre-discovered entities (already enumerated — go straight to investigating these):\n  - ${manifestList}`;
    }

    let strategyNote = "";
    if (inputData.enumerationStrategy === "scraper" && inputData.manifest.length === 0) {
      strategyNote = `\n\nNote: This dataset has an authoritative source${inputData.sourceUrl ? ` (${inputData.sourceUrl})` : ""}. Start your search there — it likely contains a directory or listing of all entities.`;
    }

    // Only include prior-context sections when the dataset is non-empty.
    let priorBlocklistNote = "";
    if (inputData.priorRowCount > 0 && pkColumns.length > 0) {
      const MAX_LISTED = 150;
      const total = inputData.priorPkValues.length;
      const listed = inputData.priorPkValues.slice(0, MAX_LISTED);
      const pkLines = listed
        .map((entry) =>
          pkColumns.map((pk) => entry[pk.name] ?? "").join(" | "),
        )
        .join("\n");
      const truncationNote =
        total > MAX_LISTED ? `\n  … and ${total - MAX_LISTED} more` : "";
      priorBlocklistNote = `\n\nALREADY IN DATASET (${inputData.priorRowCount} rows — do NOT re-investigate these):\n${pkLines}${truncationNote}`;
    } else if (inputData.priorRowCount > 0) {
      // No PK columns — just tell the orchestrator how many rows exist.
      priorBlocklistNote = `\n\nALREADY IN DATASET: ${inputData.priorRowCount} rows already collected. Find new entities not yet covered.`;
    }

    let howFoundNote = "";
    if (inputData.howFoundSamples.length > 0) {
      const sampleLines = inputData.howFoundSamples
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n\n");
      howFoundNote = `\n\nPROVEN SEARCH PATTERNS (use these as starting points to find new rows — they describe exactly how previous entities were found):\n${sampleLines}`;
    }

    const prompt = `Dataset: ${inputData.datasetName}
Description: ${inputData.description}

Data fields to collect:
${columnsDesc}${pkNote}${priorBlocklistNote}${howFoundNote}${manifestNote}${strategyNote}

Search the web broadly to find real entities that fit this dataset topic.
For each lead you find, call run_subagent with the primary key values and any context/URLs you have found.`;

    console.log(
      `[build-prompt] Built append prompt for ${inputData.datasetName} (${inputData.columns.length} columns, prior=${inputData.priorRowCount} rows, strategy=${inputData.enumerationStrategy})`,
    );
    return {
      prompt,
      authorizedDatasetId: inputData.datasetId,
      authContext: inputData.authContext,
      columns: inputData.columns,
    };
  },
});

export const appendWorkflow = createWorkflow({
  id: "append-workflow",
  inputSchema: appendInputSchema,
  outputSchema: z.object({ text: z.string() }),
})
  .then(buildContextStep)
  .then(enumerateStep)
  .then(buildPromptStep)
  .then(agentStep)
  .commit();
