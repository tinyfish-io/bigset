import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByDataset = query({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
  },
});

export const insert = mutation({
  args: {
    datasetId: v.id("datasets"),
    data: v.record(v.string(), v.any()),
    sources: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("datasetRows", args);
  },
});

export const update = mutation({
  args: {
    id: v.id("datasetRows"),
    data: v.record(v.string(), v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Row not found");

    const oldData = existing.data as Record<string, unknown>;
    const newData = args.data;

    for (const [key, newVal] of Object.entries(newData)) {
      const oldVal = oldData[key];
      if (String(oldVal) !== String(newVal)) {
        await ctx.db.insert("datasetHistory", {
          datasetRowId: args.id,
          columnName: key,
          oldValue: String(oldVal ?? ""),
          newValue: String(newVal ?? ""),
          changedAt: Date.now(),
        });
      }
    }

    await ctx.db.patch(args.id, { data: newData });
  },
});

export const insertBatch = mutation({
  args: {
    datasetId: v.id("datasets"),
    rows: v.array(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    for (const data of args.rows) {
      await ctx.db.insert("datasetRows", {
        datasetId: args.datasetId,
        data,
      });
    }
  },
});
