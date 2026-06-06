import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

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
 * List runs for a dataset, newest first.
 * Cursor-based pagination keeps memory bounded as run history grows.
 */
export const listByDataset = internalQuery({
  args: {
    datasetId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const { page, isDone, continueCursor } = await ctx.db
      .query("runStats")
      .withIndex("by_dataset_started_at", (q) =>
        q.eq("datasetId", args.datasetId),
      )
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: limit,
      });

    return { runs: page, isDone, continueCursor };
  },
});

/**
 * List runs for a user, newest first.
 */
export const listByUser = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const { page, isDone, continueCursor } = await ctx.db
      .query("runStats")
      .withIndex("by_user_started_at", (q) => q.eq("userId", args.userId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: limit,
      });

    return { runs: page, isDone, continueCursor };
  },
});
