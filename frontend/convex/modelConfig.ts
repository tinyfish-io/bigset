import { query, mutation, internalQuery, internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { getIdentity } from "./lib/authz.js";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getIdentity(ctx);
    if (!identity) return null;

    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .first();
    return existing ?? null;
  },
});

/**
 * Upsert one or more model preferences for the authenticated user.
 *
 * Only fields that are explicitly provided (not undefined) are updated.
 * Unset fields retain their existing database values.
 *
 * Example: sending only { schemaInference: "x" } will update schemaInference
 * while leaving populateOrchestrator and investigateSubagent untouched.
 */
export const upsert = mutation({
  args: {
    schemaInference: v.optional(v.string()),
    populateOrchestrator: v.optional(v.string()),
    investigateSubagent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await getIdentity(ctx);
    if (!identity) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .first();

    if (existing) {
      // Partial update — only touch fields that were explicitly provided.
      // Omitting a field preserves its current database value.
      const patch: Record<string, string | null> = {};
      if (args.schemaInference !== undefined) patch.schemaInference = args.schemaInference;
      if (args.populateOrchestrator !== undefined) patch.populateOrchestrator = args.populateOrchestrator;
      if (args.investigateSubagent !== undefined) patch.investigateSubagent = args.investigateSubagent;
      await ctx.db.patch(existing._id, patch);
    } else {
      // First-time save — build insert object from provided fields only.
      // userId is always required and comes from the authenticated identity.
      const insert: Record<string, string> = { userId: identity.subject };
      if (args.schemaInference !== undefined) insert.schemaInference = args.schemaInference;
      if (args.populateOrchestrator !== undefined) insert.populateOrchestrator = args.populateOrchestrator;
      if (args.investigateSubagent !== undefined) insert.investigateSubagent = args.investigateSubagent;
      await ctx.db.insert("modelConfig", insert);
    }
  },
});

export const getInternal = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    return existing ?? null;
  },
});

/**
 * Upsert model preferences for a specific user (internal, backend-only).
 *
 * Only fields that are explicitly provided (not undefined) are updated.
 * Unset fields are omitted from the insert, leaving the database unchanged.
 */
export const upsertInternal = internalMutation({
  args: {
    userId: v.string(),
    schemaInference: v.optional(v.string()),
    populateOrchestrator: v.optional(v.string()),
    investigateSubagent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    const patch: Record<string, string | null> = {};
    if (args.schemaInference !== undefined) patch.schemaInference = args.schemaInference;
    if (args.populateOrchestrator !== undefined) patch.populateOrchestrator = args.populateOrchestrator;
    if (args.investigateSubagent !== undefined) patch.investigateSubagent = args.investigateSubagent;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("modelConfig", {
        userId: args.userId,
        ...patch,
      });
    }
  },
});