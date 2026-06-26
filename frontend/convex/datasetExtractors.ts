import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

export const getActive = internalQuery({
  args: {
    datasetId: v.id("datasets"),
    siteKey: v.string(),
    columnsHash: v.string(),
  },
  handler: async (ctx, args) => {
    const extractor = await ctx.db
      .query("datasetExtractors")
      .withIndex("by_dataset_site", (q) =>
        q.eq("datasetId", args.datasetId).eq("siteKey", args.siteKey),
      )
      .first();

    if (
      !extractor ||
      extractor.columnsHash !== args.columnsHash ||
      extractor.status !== "active"
    ) {
      return null;
    }

    return extractor;
  },
});

export const upsert = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    siteKey: v.string(),
    columnsHash: v.string(),
    script: v.string(),
    model: v.optional(v.string()),
    probeSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const dataset = await ctx.db.get(args.datasetId);
    if (!dataset) throw new Error("Dataset not found");

    const now = Date.now();
    const existing = await ctx.db
      .query("datasetExtractors")
      .withIndex("by_dataset_site", (q) =>
        q.eq("datasetId", args.datasetId).eq("siteKey", args.siteKey),
      )
      .first();

    const patch = {
      columnsHash: args.columnsHash,
      script: args.script,
      status: "active" as const,
      model: args.model,
      probeSummary: args.probeSummary,
      lastError: undefined,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { id: existing._id, updatedAt: now };
    }

    const id = await ctx.db.insert("datasetExtractors", {
      datasetId: args.datasetId,
      siteKey: args.siteKey,
      createdAt: now,
      ...patch,
    });
    return { id, updatedAt: now };
  },
});

export const markFailed = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    siteKey: v.string(),
    columnsHash: v.string(),
    script: v.string(),
    updatedAt: v.number(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("datasetExtractors")
      .withIndex("by_dataset_site", (q) =>
        q.eq("datasetId", args.datasetId).eq("siteKey", args.siteKey),
      )
      .first();
    if (
      !existing ||
      existing.columnsHash !== args.columnsHash ||
      existing.script !== args.script ||
      existing.updatedAt !== args.updatedAt
    ) {
      return null;
    }

    await ctx.db.patch(existing._id, {
      status: "failed",
      lastError: args.error.slice(0, 1_000),
      updatedAt: Date.now(),
    });
    return existing._id;
  },
});
