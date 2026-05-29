import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

/**
 * Insert a populate-run metrics record.
 *
 * Called by the backend agent runner at the end of every populate workflow
 * run (success or error). Never called from the browser.
 */
export const insert = internalMutation({
  args: {
    workflowRunId: v.string(),
    datasetId: v.string(),
    userId: v.string(),
    startedAt: v.number(),
    finishedAt: v.number(),
    durationMs: v.number(),

    searchCalls: v.number(),
    fetchCalls: v.number(),
    investigateCalls: v.number(),
    rowsInserted: v.number(),

    tokensInput: v.number(),
    tokensOutput: v.number(),

    orchestratorTokensInput: v.number(),
    orchestratorTokensOutput: v.number(),
    orchestratorSteps: v.number(),
    investigateTokensInput: v.number(),
    investigateTokensOutput: v.number(),
    investigateSteps: v.number(),
    investigateRuns: v.number(),

    status: v.union(v.literal("success"), v.literal("error")),
    error: v.optional(v.string()),
    isBenchmark: v.optional(v.boolean()),
    workflowType: v.optional(
      v.union(v.literal("populate"), v.literal("update"))
    ),
    rowsUpdated: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.status === "success" && args.error) {
      throw new Error("runStats.insert: error must be absent on a successful run");
    }
    if (args.status === "error" && !args.error) {
      throw new Error("runStats.insert: error message is required on a failed run");
    }
    await ctx.db.insert("runStats", args);
  },
});

/**
 * Fetch a single run by its workflowRunId. Used by the benchmark runner to
 * retrieve metrics after a workflow completes.
 */
export const getByWorkflowRunId = internalQuery({
  args: { workflowRunId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runStats")
      .withIndex("by_workflow_run", (q) =>
        q.eq("workflowRunId", args.workflowRunId),
      )
      .first();
  },
});

/**
 * List all runs for a dataset, newest first.
 * TODO: paginate — .collect() loads all docs into memory and will degrade
 * as run history grows. Add cursor-based pagination when this is exposed
 * to the frontend or run counts become large.
 */
export const listByDataset = internalQuery({
  args: { datasetId: v.string() },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("runStats")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  },
});

/**
 * List all runs for a user, newest first.
 * TODO: paginate — same concern as listByDataset above.
 */
export const listByUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("runStats")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  },
});
