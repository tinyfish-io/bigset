import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { datasetContextSchema } from "../../pipeline/populate.js";
import { convex, internal } from "../../convex.js";
import { buildPopulateAgent } from "../agents/populate.js";

/**
 * Server-set auth/run context threaded through every step.
 *
 * The HTTP route (`/populate` in `src/index.ts`) fills this in from the
 * verified Clerk JWT and the Mastra run handle BEFORE calling
 * `workflow.start()`. The client cannot supply these fields — they live
 * on the workflow input but not on `datasetContextSchema`, which is what
 * the route validates against `req.body`.
 *
 * Carried to:
 *   - `buildPopulateAgent(...)` (via `authContext`) so the dataset tools
 *     can attach caller attribution to security/observability logs and
 *     PostHog capability-violation events.
 *
 * `workflowRunId` is intentionally a plain string so callers can pass
 * whatever id the orchestration layer gave them (Mastra run id, or a
 * fresh UUID as a fallback) without coupling this schema to a specific
 * runtime.
 */
export const authContextSchema = z.object({
  authorizedUserId: z.string().min(1),
  workflowRunId: z.string().min(1),
});
export type AuthContext = z.infer<typeof authContextSchema>;

export const populateInputSchema = datasetContextSchema.extend({
  authContext: authContextSchema,
});
export type PopulateInput = z.infer<typeof populateInputSchema>;

const clearRowsStep = createStep({
  id: "clear-rows",
  inputSchema: populateInputSchema,
  outputSchema: populateInputSchema,
  execute: async ({ inputData }) => {
    console.log(`[clear-rows] Clearing rows for dataset ${inputData.datasetId}`);
    await convex.mutation(internal.datasetRows.clearByDataset, {
      datasetId: inputData.datasetId,
    });
    console.log(`[clear-rows] Done`);
    return inputData;
  },
});

const buildPromptOutputSchema = z.object({
  prompt: z.string(),
  // Threaded through so the agent step can build a dataset-scoped agent.
  // The LLM never sees these fields — they stay in the workflow envelope.
  authorizedDatasetId: z.string(),
  authContext: authContextSchema,
});

const buildPromptStep = createStep({
  id: "build-prompt",
  inputSchema: populateInputSchema,
  outputSchema: buildPromptOutputSchema,
  execute: async ({ inputData }) => {
    const columnNames = inputData.columns.map((c) => c.name);
    const columnsDesc = inputData.columns
      .map(
        (c) =>
          `- "${c.name}" (${c.type})${c.description ? `: ${c.description}` : ""}`,
      )
      .join("\n");

    // Note: `datasetId` is intentionally OMITTED from the prompt. The
    // agent's tools are pre-bound to the authorized dataset via closure
    // (see tools/dataset-tools.ts). If the LLM doesn't know the id, it
    // can't be tricked into typing it into a redirect attempt — and even
    // if it could, the tools no longer accept that argument.
    const prompt = `Dataset: ${inputData.datasetName}
Description: ${inputData.description}

Columns:
${columnsDesc}

When calling insert_row, the data object keys MUST be exactly these strings (no backticks, no extra quotes):
${JSON.stringify(columnNames)}

Example insert_row call:
insert_row({ data: { ${columnNames.map((n) => `"${n}": <value>`).join(", ")} } })

Search the web for real data about this topic. Then call insert_row to fill in 10 rows. Use real data from your search. Fill in any gaps with realistic fake data.`;

    console.log(
      `[build-prompt] Built prompt for ${inputData.datasetName} (${inputData.columns.length} columns)`,
    );
    return {
      prompt,
      authorizedDatasetId: inputData.datasetId,
      authContext: inputData.authContext,
    };
  },
});

/**
 * Custom agent step.
 *
 * We can't use `createStep(populateAgent, { maxSteps: 80 })` anymore
 * because the agent is no longer a module-level singleton — it has to be
 * built per-run with the authorized dataset baked into its tools (closure
 * capability scope; see tools/dataset-tools.ts). So this step does what
 * Mastra's agent-as-step adapter would do internally: build the agent,
 * call `.generate(prompt, { maxSteps })`, return the text.
 */
const agentStep = createStep({
  id: "populate-agent",
  inputSchema: buildPromptOutputSchema,
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData }) => {
    const agent = buildPopulateAgent(
      inputData.authorizedDatasetId,
      inputData.authContext,
    );
    const result = await agent.generate(inputData.prompt, { maxSteps: 80 });
    return { text: result.text };
  },
});

export const populateWorkflow = createWorkflow({
  id: "populate-workflow",
  inputSchema: populateInputSchema,
  outputSchema: z.object({ text: z.string() }),
})
  .then(clearRowsStep)
  .then(buildPromptStep)
  .then(agentStep)
  .commit();
