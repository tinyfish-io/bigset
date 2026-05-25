import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildInvestigateAgent } from "../agents/investigate.js";
import { buildTriageExtractAgent } from "../agents/triage-extract.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";
import { convex, internal } from "../../convex.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

interface RowIndexEntry {
  rowId: string;
  confidence: number;
  /** Column values only — no internal _-prefixed fields. */
  cells: Record<string, unknown>;
}

// ─── Triage status ────────────────────────────────────────────────────────────

const TRIAGE_STATUSES = [
  "extract_now",
  "needs_browser_agent",
  "needs_form_fill",
  "low_value",
  "blocked",
] as const;
type TriageStatus = (typeof TRIAGE_STATUSES)[number];

// ─── Output parsers ───────────────────────────────────────────────────────────

/**
 * Parse structured keyword output from the triage-extract agent.
 * Format: TRIAGE_STATUS / TRIAGE_REASON / LEADS / SOURCE_QUALITY labels.
 */
function parseTriageExtractOutput(text: string): {
  triage_status: TriageStatus;
  triage_reason: string;
  leads: string;
  source_quality: string;
} {
  const statusMatch = text.match(/TRIAGE_STATUS:\s*(\S+)/i);
  const reasonMatch = text.match(
    /TRIAGE_REASON:\s*([\s\S]*?)(?=\nLEADS:|\nSOURCE_QUALITY:|$)/i,
  );
  const leadsMatch = text.match(
    /LEADS:\s*([\s\S]*?)(?=\nSOURCE_QUALITY:|$)/i,
  );
  const sourceMatch = text.match(/SOURCE_QUALITY:\s*([\s\S]*?)$/i);

  const raw = statusMatch?.[1]?.toLowerCase().trim() ?? "";
  const triage_status: TriageStatus = (
    TRIAGE_STATUSES.includes(raw as TriageStatus) ? raw : "low_value"
  ) as TriageStatus;

  return {
    triage_status,
    triage_reason: reasonMatch?.[1]?.trim() ?? text.slice(0, 200),
    leads: leadsMatch?.[1]?.trim() ?? "",
    source_quality: sourceMatch?.[1]?.trim() ?? "",
  };
}

/**
 * Parse structured keyword output from the investigate agent.
 * Format: INSERTED / SUMMARY / CLUES / REASON labels (matches main-branch pattern).
 */
function parseInvestigateOutput(text: string): {
  findings: string;
  leads: string;
} {
  const summaryMatch = text.match(
    /SUMMARY:\s*([\s\S]*?)(?=\nCLUES:|\nREASON:|$)/i,
  );
  const cluesMatch = text.match(/CLUES:\s*([\s\S]*?)(?=\nREASON:|$)/i);
  const reasonMatch = text.match(/REASON:\s*([\s\S]*?)$/i);

  const findings = [summaryMatch?.[1]?.trim(), reasonMatch?.[1]?.trim()]
    .filter(Boolean)
    .join(" — ");

  return {
    findings: findings || text.slice(0, 300),
    leads: cluesMatch?.[1]?.trim() ?? "",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanDataKeys(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    cleaned[key.replace(/^["`]+|["`]+$/g, "")] = value;
  }
  return cleaned;
}

function isRowComplete(
  cells: Record<string, unknown>,
  columns: PopulateColumn[],
): boolean {
  return columns.every((col) => {
    const val = cells[col.name];
    return val !== null && val !== undefined && val !== "";
  });
}

// ─── Per-call tool builders ───────────────────────────────────────────────────

function buildInsertRowTool(
  rowIndex: Map<string, RowIndexEntry>,
  authorizedDatasetId: string,
  logCtx: string,
  columns: PopulateColumn[],
  primaryKeyColumn: string,
) {
  const columnNames = columns.map((c) => c.name);

  return createTool({
    id: "insert_row",
    description:
      "Insert a new row into the dataset. " +
      "Provide confidence (0–1: 1.0 = official primary source, 0.5 = aggregator, 0.2 = indirect mention), " +
      "sources (column name → URL for every column you filled; \"\" if unverifiable), " +
      "and data (column values; \"\" for columns you cannot verify). " +
      "Never fabricate values — leave blank instead.",
    inputSchema: z.object({
      primary_key: z
        .string()
        .describe(
          `Value of the primary key column "${primaryKeyColumn}" — used for deduplication`,
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("Source confidence 0–1"),
      sources: z
        .record(z.string(), z.string())
        .describe(
          'Map of column name → source URL for each column you filled. Use "" for unverifiable columns.',
        ),
      data: z
        .record(z.string(), z.any())
        .describe(
          `Object with exactly these keys: ${JSON.stringify(columnNames)}. Use "" for unverifiable columns.`,
        ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      rowId: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ primary_key, confidence, sources, data }) => {
      if (!data || Object.keys(data).length === 0)
        return { success: false, error: "data is required." };

      const cleanedData = cleanDataKeys(data);
      const enrichedData: Record<string, unknown> = {
        ...cleanedData,
        _confidence: confidence,
        _sources: sources,
      };
      const sourceUrls = Array.from(
        new Set(Object.values(sources).filter(Boolean)),
      );

      console.log(
        `[insert_row] ${logCtx} pk="${primary_key}" confidence=${confidence} cols=${Object.keys(cleanedData).length}`,
      );
      try {
        const rowId = await convex.mutation(internal.datasetRows.insert, {
          datasetId: authorizedDatasetId,
          data: enrichedData,
          sources: sourceUrls,
        });

        const cells: Record<string, unknown> = {};
        for (const col of columns) cells[col.name] = cleanedData[col.name] ?? "";
        rowIndex.set(primary_key, { rowId: rowId as string, confidence, cells });

        return { success: true, rowId: rowId as string };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[insert_row] Failed: ${logCtx} pk="${primary_key}" err=${msg}`,
        );
        if (msg.includes("Quota") || msg.includes("quota"))
          return {
            success: false,
            error: `Quota exceeded: ${msg}. Stop inserting rows for this billing period.`,
          };
        if (msg.includes("validator"))
          return {
            success: false,
            error: `Validation failed: ${msg}. Check that column keys are plain strings.`,
          };
        return { success: false, error: `Insert failed: ${msg}` };
      }
    },
  });
}

function buildUpdateRowByKeyTool(
  rowIndex: Map<string, RowIndexEntry>,
  authorizedDatasetId: string,
  logCtx: string,
  columns: PopulateColumn[],
) {
  return createTool({
    id: "update_row_by_key",
    description:
      "Update an existing row identified by its primary key value — but ONLY if your " +
      "source has HIGHER confidence than the current data. Automatically skipped " +
      "(success: true, skipped: true) if existing confidence is equal or higher. " +
      "Non-empty values in data override existing values; empty strings are ignored " +
      "(existing filled cells are never overwritten with blanks). " +
      "Provide source URLs for each column you are updating.",
    inputSchema: z.object({
      primary_key: z
        .string()
        .describe("Primary key value of the row to update"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("Your source confidence 0–1"),
      data: z
        .record(z.string(), z.any())
        .describe(
          "Column values to update. Non-empty values override existing; empty strings are skipped.",
        ),
      sources: z
        .record(z.string(), z.string())
        .describe("Column name → source URL for each column you are updating"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      skipped: z.boolean().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ primary_key, confidence, data, sources }) => {
      const existing = rowIndex.get(primary_key);
      if (!existing) {
        return {
          success: false,
          error: `"${primary_key}" not found. Use insert_row for new entities.`,
        };
      }
      if (confidence <= existing.confidence) {
        console.log(
          `[update_row_by_key] ${logCtx} pk="${primary_key}" skipped ` +
            `(existing confidence ${existing.confidence.toFixed(2)} >= ${confidence.toFixed(2)})`,
        );
        return { success: true, skipped: true };
      }

      const cleanedNew = cleanDataKeys(data);
      const mergedCells: Record<string, unknown> = { ...existing.cells };
      for (const [col, val] of Object.entries(cleanedNew)) {
        if (val !== null && val !== undefined && val !== "") {
          mergedCells[col] = val;
        }
      }

      const enrichedData: Record<string, unknown> = {
        ...mergedCells,
        _confidence: confidence,
        _sources: sources,
      };

      console.log(
        `[update_row_by_key] ${logCtx} pk="${primary_key}" ` +
          `confidence ${existing.confidence.toFixed(2)}→${confidence.toFixed(2)}`,
      );
      try {
        await convex.mutation(internal.datasetRows.update, {
          id: existing.rowId as any,
          expectedDatasetId: authorizedDatasetId,
          data: enrichedData,
        });

        rowIndex.set(primary_key, {
          rowId: existing.rowId,
          confidence,
          cells: mergedCells,
        });

        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[update_row_by_key] Failed: ${logCtx} pk="${primary_key}" err=${msg}`,
        );
        if (msg.includes("Row not found") || msg.includes("not found"))
          return {
            success: false,
            error: "Row no longer exists — it may have been deleted.",
          };
        return { success: false, error: `Update failed: ${msg}` };
      }
    },
  });
}

// ─── Main tool factory ────────────────────────────────────────────────────────

/**
 * Build the extract_rows and list_rows tools scoped to one dataset.
 *
 * Both tools share the same rowIndex, which is the canonical in-memory
 * state for this workflow run. All reads and writes go through this closure
 * so deduplication and confidence-gated updates work across parallel calls.
 *
 * extract_rows:
 *   Dispatches one URL to a triage-extract agent. The agent fetches the page,
 *   classifies it (extract_now / needs_browser_agent / etc.), extracts all
 *   matching entities, then spawns investigate_entity sub-agents for rows
 *   with missing columns. Returns triage metadata and natural language leads.
 *
 * list_rows:
 *   Returns a compact text summary of all rows in the dataset — which are
 *   complete, which have missing columns, and their confidence levels. Used
 *   by the populate orchestrator to track progress and decide when to stop.
 *
 * authorizedDatasetId and authContext are never exposed in tool schemas;
 * they are captured by closure for Convex writes and security logging.
 *
 * A fresh call to buildExtractTool per workflow run is required — do not
 * cache the returned tools across runs.
 */
export function buildExtractTool(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  targetRows: number = 20,
): { extractRowsTool: ReturnType<typeof createTool>; listRowsTool: ReturnType<typeof createTool> } {
  const primaryKeyColumn = columns[0]?.name ?? "";
  const columnNames = columns.map((c) => c.name);
  const logCtx = `user=${authContext.authorizedUserId} run=${authContext.workflowRunId} dataset=${authorizedDatasetId}`;

  // Shared mutable state across all extract_rows and investigate_entity
  // invocations in this workflow run.
  const rowIndex = new Map<string, RowIndexEntry>();

  function countCompleteRows(): number {
    let n = 0;
    for (const { cells } of rowIndex.values()) {
      if (isRowComplete(cells, columns)) n++;
    }
    return n;
  }

  function buildExistingRowsText(): string {
    if (rowIndex.size === 0) return "None yet.";
    const lines: string[] = [];
    for (const [pk, { cells, confidence }] of rowIndex.entries()) {
      const missing = columns
        .filter((c) => !cells[c.name] && cells[c.name] !== 0)
        .map((c) => c.name);
      const status =
        missing.length === 0
          ? "[COMPLETE]"
          : `[INCOMPLETE — missing: ${missing.join(", ")}]`;
      const cellPairs = columnNames
        .map((n) => `${n}: ${JSON.stringify(cells[n] ?? "")}`)
        .join(", ");
      lines.push(
        `• "${pk}" | ${cellPairs} | confidence ${confidence.toFixed(2)} ${status}`,
      );
    }
    return lines.join("\n");
  }

  // ── investigate_entity tool ─────────────────────────────────────────────────
  // Built once per buildExtractTool call; closes over the shared rowIndex.
  // Each invocation spawns a fresh investigate agent with its own step budget.

  function buildInvestigateEntityTool() {
    return createTool({
      id: "investigate_entity",
      description:
        "Spawn an investigation agent to autonomously research a specific entity " +
        "and fill its missing or low-confidence columns via web search and page fetching. " +
        "Call this after inserting a row that has blank columns. " +
        "Provide the primary key, the specific missing column names, and all context " +
        "you gathered (hints, partial URLs, notes from the page) so the agent can target " +
        "its searches effectively.",
      inputSchema: z.object({
        primary_key: z
          .string()
          .describe("Primary key value of the row to investigate"),
        missing_columns: z
          .array(z.string())
          .describe(
            "Names of columns that are blank or low-confidence — the agent's priority targets",
          ),
        context: z
          .string()
          .describe(
            "Everything you know about this entity: partial data found, " +
              "hints from the page, source URLs where you found it, " +
              "any clues that might help targeted searches",
          ),
      }),
      outputSchema: z.object({
        findings: z.string(),
        leads: z.string(),
      }),
      execute: async ({ primary_key, missing_columns, context }) => {
        const existing = rowIndex.get(primary_key);
        if (!existing) {
          return {
            findings: `Row "${primary_key}" not found in dataset — cannot investigate.`,
            leads: "",
          };
        }

        const existingDataText = columnNames
          .map(
            (n) =>
              `${n}: ${JSON.stringify(existing.cells[n] ?? "")}${!existing.cells[n] && existing.cells[n] !== 0 ? " [MISSING]" : ""}`,
          )
          .join(", ");

        console.log(
          `[investigate_entity] ${logCtx} pk="${primary_key}" missing=${missing_columns.join(",")}`,
        );

        try {
          // Build a fresh update tool for this investigation (shares rowIndex).
          const updateTool = buildUpdateRowByKeyTool(
            rowIndex,
            authorizedDatasetId,
            `${logCtx} investigate="${primary_key}"`,
            columns,
          );
          const agent = buildInvestigateAgent(
            columns,
            primaryKeyColumn,
            updateTool,
          );

          const prompt =
            `Research this entity: "${primary_key}"\n\n` +
            `Currently known data: ${existingDataText}\n` +
            `Missing columns to fill (priority): ${missing_columns.join(", ")}\n\n` +
            `Context from extraction:\n${context}`;

          const result = await agent.generate(prompt, { maxSteps: 20 });
          const parsed = parseInvestigateOutput(result.text);

          console.log(
            `[investigate_entity] done ${logCtx} pk="${primary_key}" steps=${result.steps?.length ?? "?"}`,
          );

          return { findings: parsed.findings, leads: parsed.leads };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[investigate_entity] error ${logCtx} pk="${primary_key}" err=${msg}`,
          );
          return {
            findings: `Investigation failed: ${msg}`,
            leads: "",
          };
        }
      },
    });
  }

  // ── list_rows tool ──────────────────────────────────────────────────────────
  // Reads the shared rowIndex and returns a compact summary for the orchestrator.

  const listRowsTool = createTool({
    id: "list_rows",
    description:
      "Get a compact summary of all rows currently in the dataset — which are complete, " +
      "which have missing columns, and their confidence levels. " +
      "Call this after each batch of extract_rows calls to track progress toward the target " +
      "row count and decide whether to continue or stop.",
    inputSchema: z.object({}),
    outputSchema: z.object({ summary: z.string() }),
    execute: async () => {
      const complete = countCompleteRows();
      const total = rowIndex.size;
      if (total === 0) return { summary: "No rows yet." };

      const lines = [
        `${total} rows total (${complete} complete, ${total - complete} incomplete).`,
      ];
      for (const [pk, { cells, confidence }] of rowIndex.entries()) {
        const missing = columns
          .filter((c) => !cells[c.name] && cells[c.name] !== 0)
          .map((c) => c.name);
        const status =
          missing.length === 0
            ? "[COMPLETE]"
            : `[INCOMPLETE — missing: ${missing.join(", ")}]`;
        const preview = columnNames
          .map((n) => `${n}: ${JSON.stringify(cells[n] ?? "")}`)
          .join(", ");
        lines.push(
          `• "${pk}" | ${preview} | confidence ${confidence.toFixed(2)} ${status}`,
        );
      }
      return { summary: lines.join("\n") };
    },
  });

  // ── extract_rows tool ───────────────────────────────────────────────────────

  const extractRowsTool = createTool({
    id: "extract_rows",
    description:
      "Dispatch ONE prioritized source URL to a triage-extract agent. " +
      "The agent fetches the page, classifies it (extract_now / needs_browser_agent / " +
      "needs_form_fill / low_value / blocked), extracts all matching entities, " +
      "and automatically dispatches investigation for rows with missing columns. " +
      "Returns triage metadata and natural language leads for your next dispatches.",
    inputSchema: z.object({
      source_urls: z
        .array(z.string())
        .min(1)
        .max(1)
        .describe(
          "Exactly 1 URL from search results. " +
            "Use title, snippet, and site name to pick the most relevant page.",
        ),
      context: z
        .string()
        .describe(
          "What to extract: entity type, data signals seen in search snippets/titles, " +
            "any partial information already known. The agent has no other context.",
        ),
      notes: z
        .string()
        .optional()
        .describe(
          "Hints from previous extraction results: URL patterns, source types that worked, etc.",
        ),
    }),
    outputSchema: z.object({
      triage_status: z.enum([
        "extract_now",
        "needs_browser_agent",
        "needs_form_fill",
        "low_value",
        "blocked",
      ]),
      triage_reason: z.string(),
      leads: z.string(),
      source_quality: z.string(),
    }),
    execute: async ({ source_urls, context, notes }) => {
      console.log(
        `[extract_rows] ${logCtx} url=${source_urls[0]} known_rows=${rowIndex.size}`,
      );

      // Hard cap: if target is already reached, skip.
      const completeAtStart = countCompleteRows();
      if (completeAtStart >= targetRows) {
        console.log(
          `[extract_rows] ${logCtx} skipping — target already reached (${completeAtStart}/${targetRows})`,
        );
        return {
          triage_status: "low_value" as TriageStatus,
          triage_reason: `Target row count (${targetRows}) already reached — skipping.`,
          leads: "",
          source_quality: "",
        };
      }

      try {
        // Refresh rowIndex from Convex for any rows added by parallel calls.
        const currentRows = await convex.query(
          internal.datasetRows.listInternal,
          { datasetId: authorizedDatasetId },
        );
        for (const row of currentRows) {
          const d = row.data as Record<string, unknown>;
          const pk = String(d[primaryKeyColumn] ?? "");
          if (!pk || rowIndex.has(pk)) continue;
          const cells: Record<string, unknown> = {};
          for (const col of columns) cells[col.name] = d[col.name] ?? "";
          rowIndex.set(pk, {
            rowId: row._id as string,
            confidence: typeof d._confidence === "number" ? d._confidence : 0.5,
            cells,
          });
        }

        const existingRowsText = buildExistingRowsText();

        // Build per-call tools sharing the run-level rowIndex.
        const insertRowTool = buildInsertRowTool(
          rowIndex,
          authorizedDatasetId,
          logCtx,
          columns,
          primaryKeyColumn,
        );
        const updateRowByKeyTool = buildUpdateRowByKeyTool(
          rowIndex,
          authorizedDatasetId,
          logCtx,
          columns,
        );
        const investigateEntityTool = buildInvestigateEntityTool();

        const sourceUrl = source_urls[0];
        const notesBlock = notes ? `\nAdditional hints:\n${notes}` : "";
        const prompt =
          `Fetch and process this URL: ${sourceUrl}\n\n` +
          `Context: ${context}${notesBlock}\n\n` +
          `Existing rows in the dataset:\n${existingRowsText}`;

        const agent = buildTriageExtractAgent(
          columns,
          primaryKeyColumn,
          insertRowTool,
          updateRowByKeyTool,
          investigateEntityTool,
        );

        const result = await agent.generate(prompt, { maxSteps: 40 });
        const parsed = parseTriageExtractOutput(result.text);

        console.log(
          `[extract_rows] done ${logCtx} triage=${parsed.triage_status} ` +
            `rows=${rowIndex.size} complete=${countCompleteRows()} steps=${result.steps?.length ?? "?"}`,
        );

        return parsed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extract_rows] error ${logCtx} err=${msg}`);
        return {
          triage_status: "blocked" as TriageStatus,
          triage_reason: `Extraction agent failed: ${msg}`,
          leads: "",
          source_quality: "",
        };
      }
    },
  });

  return { extractRowsTool, listRowsTool };
}
