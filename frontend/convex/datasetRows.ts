import { query, internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { loadReadableDataset } from "./lib/authz.js";

/**
 * Read all rows of a dataset.
 *
 * Authorized via the parent dataset: caller must be the owner, or the
 * dataset must be public. `loadReadableDataset` returns a uniform
 * "Dataset not found" for both missing and unauthorized — see authz.ts.
 */
export const listByDataset = query({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    await loadReadableDataset(ctx, args.datasetId);

    return await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
  },
});

/**
 * Row writes are SYSTEM-LEVEL operations performed by the agent runner,
 * never by end users directly. They are exposed as `internalMutation` so
 * they cannot be called from the browser — only from other Convex
 * functions or from a trusted backend authenticated with the Convex
 * admin key.
 *
 * If user-facing row editing is ever introduced, add a separate purpose-
 * built public mutation (e.g. `userEditCell`) that performs ownership
 * checks via `loadOwnedDataset` first. Do not relax these to public.
 */
export const insert = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    data: v.record(v.string(), v.any()),
    sources: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("datasetRows", args);
  },
});

export const update = internalMutation({
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

export const insertBatch = internalMutation({
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
