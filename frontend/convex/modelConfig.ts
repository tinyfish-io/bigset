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
      await ctx.db.patch(existing._id, {
        schemaInference: args.schemaInference,
        populateOrchestrator: args.populateOrchestrator,
        investigateSubagent: args.investigateSubagent,
      });
    } else {
      await ctx.db.insert("modelConfig", {
        userId: identity.subject,
        schemaInference: args.schemaInference,
        populateOrchestrator: args.populateOrchestrator,
        investigateSubagent: args.investigateSubagent,
      });
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