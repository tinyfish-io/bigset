import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listWithPreview = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const datasets = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .collect();

    return Promise.all(
      datasets.map(async (ds) => {
        const rows = await ctx.db
          .query("datasetRows")
          .withIndex("by_dataset", (q) => q.eq("datasetId", ds._id))
          .take(5);
        return {
          ...ds,
          previewRows: rows.map((r) => r.data),
        };
      })
    );
  },
});

export const get = query({
  args: { id: v.id("datasets") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return await ctx.db.get(args.id);
  },
});

const columnValidator = v.object({
  name: v.string(),
  type: v.union(
    v.literal("text"),
    v.literal("number"),
    v.literal("boolean"),
    v.literal("url"),
    v.literal("date")
  ),
  description: v.optional(v.string()),
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    cadence: v.string(),
    columns: v.array(columnValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return await ctx.db.insert("datasets", {
      ...args,
      ownerId: identity.subject,
      status: "building",
    });
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("datasets"),
    status: v.union(
      v.literal("live"),
      v.literal("paused"),
      v.literal("building")
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const remove = mutation({
  args: { id: v.id("datasets") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const rows = await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.id))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.delete(args.id);
  },
});
