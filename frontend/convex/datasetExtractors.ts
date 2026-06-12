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
      extractor.status !== "active" ||
      extractor.columnsHash !== args.columnsHash
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
      return existing._id;
    }

    return await ctx.db.insert("datasetExtractors", {
      datasetId: args.datasetId,
      siteKey: args.siteKey,
      createdAt: now,
      ...patch,
    });
  },
});

export const markFailed = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    siteKey: v.string(),
    columnsHash: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("datasetExtractors")
      .withIndex("by_dataset_site", (q) =>
        q.eq("datasetId", args.datasetId).eq("siteKey", args.siteKey),
      )
      .first();
    if (!existing || existing.columnsHash !== args.columnsHash) return null;

    await ctx.db.patch(existing._id, {
      status: "failed",
      lastError: args.error.slice(0, 1_000),
      updatedAt: Date.now(),
    });
    return existing._id;
  },
});
