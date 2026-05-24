import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildInvestigateAgent } from "../agents/investigate.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const investigateInputSchema = z.object({
  entity_hint: z
    .string()
    .describe(
      "What entity to look for, e.g. 'head of GTM at Appcharge' or 'Starbucks coffee products on Amazon'",
    ),
  context: z
    .string()
    .describe(
      "All partial data already found: field values, URLs, snippets from search results",
    ),
  urls: z
    .array(z.string())
    .optional()
    .describe("Pages that likely contain this row's data — pass anything promising"),
  notes: z
    .string()
    .optional()
    .describe(
      "Extra clues from previous subagents or the orchestrator that might help",
    ),
});

const investigateOutputSchema = z.object({
  inserted: z.boolean(),
  row_summary: z.string().optional(),
  clues: z.string().optional(),
  reason: z.string(),
});

function parseInvestigateResult(
  text: string,
): z.infer<typeof investigateOutputSchema> {
  const insertedMatch = text.match(/INSERTED:\s*(true|false)/i);
  const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=\nCLUES:|\nREASON:|$)/is);
  const cluesMatch = text.match(/CLUES:\s*(.+?)(?=\nREASON:|$)/is);
  const reasonMatch = text.match(/REASON:\s*(.+?)$/is);

  return {
    inserted: insertedMatch?.[1]?.toLowerCase() === "true" ?? false,
    row_summary: summaryMatch?.[1]?.trim() || undefined,
    clues: cluesMatch?.[1]?.trim() || undefined,
    reason: reasonMatch?.[1]?.trim() || text.slice(0, 300),
  };
}

/**
 * Build the investigate_row tool scoped to one dataset.
 *
 * The orchestrator calls this to hand off a lead to a fresh subagent.
 * The subagent does deep research, inserts at most one row, and returns
 * structured feedback including clues for finding more rows.
 *
 * authorizedDatasetId and authContext are captured by closure — not
 * exposed in the tool schema, never visible to the orchestrator LLM.
 */
export function buildInvestigateTool(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
) {
  return createTool({
    id: "investigate_row",
    description:
      "Hand off a lead to a subagent that will research it deeply and insert a single row if it finds real, verified data. Pass all partial data and URLs you have found. Returns whether a row was inserted, plus clues for finding more entries.",
    inputSchema: investigateInputSchema,
    outputSchema: investigateOutputSchema,
    execute: async ({ entity_hint, context, urls, notes }) => {
      console.log(
        `[investigate_row] spawning subagent user=${authContext.authorizedUserId} run=${authContext.workflowRunId} dataset=${authorizedDatasetId} entity="${entity_hint}"`,
      );
      const agent = buildInvestigateAgent(
        authorizedDatasetId,
        authContext,
        columns,
      );

      const urlsBlock =
        urls && urls.length > 0
          ? `\nUseful URLs to start from:\n${urls.map((u) => `- ${u}`).join("\n")}`
          : "";
      const notesBlock = notes ? `\nAdditional notes: ${notes}` : "";

      const prompt = `Research this entity and insert a row if you find real, verified data.

Entity: ${entity_hint}

Context (partial data already found):
${context}${urlsBlock}${notesBlock}`;

      const result = await agent.generate(prompt, { maxSteps: 25 });
      const parsed = parseInvestigateResult(result.text);
      console.log(
        `[investigate_row] done entity="${entity_hint}" inserted=${parsed.inserted} steps=${result.steps?.length ?? "?"}` +
          (parsed.row_summary ? `\n  summary: ${parsed.row_summary}` : "") +
          (parsed.reason ? `\n  reason:  ${parsed.reason}` : "") +
          (parsed.clues ? `\n  clues:   ${parsed.clues}` : ""),
      );
      return parsed;
    },
  });
}
