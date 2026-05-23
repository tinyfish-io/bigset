import { query, internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { loadReadableDataset } from "./lib/authz.js";
import {
  consumeQuotaForDataset,
  consumeQuotaForRow,
} from "./lib/quota.js";

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
 * Quota: every row write charges the dataset's owner exactly once (see
 * convex/lib/quota.ts). System-owned datasets bypass quota. The charge
 * happens BEFORE the write in the same transaction, so failed writes
 * never consume quota.
 *
 * If user-facing row editing is ever introduced, add a separate purpose-
 * built public mutation (e.g. `userEditCell`) that performs ownership
 * checks via `loadOwnedDataset` first AND calls `consumeQuotaForRow`.
 * Do not relax these to public.
 */
export const insert = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    data: v.record(v.string(), v.any()),
    sources: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await consumeQuotaForDataset(ctx, args.datasetId, 1);
    return await ctx.db.insert("datasetRows", args);
  },
});

export const update = internalMutation({
  args: {
    id: v.id("datasetRows"),
    data: v.record(v.string(), v.any()),
  },
  handler: async (ctx, args) => {
    // Resolves row → dataset → consumes 1 unit of owner's quota.
    const existing = await consumeQuotaForRow(ctx, args.id, 1);

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

export const clearByDataset = internalMutation({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return rows.length;
  },
});

export const get = internalQuery({
  args: { id: v.id("datasetRows") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const remove = internalMutation({
  args: { id: v.id("datasetRows") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

/**
 * Insert N rows in one transaction.
 *
 * All-or-nothing semantics by design:
 *   - The quota layer's only job is hard enforcement (yes/no, atomic).
 *   - The agent runner's job is batch sizing — call `quota:getMy` to
 *     see `remaining`, then call insertBatch with at most that many.
 *   - Partial accept would push policy decisions ("which rows survived?")
 *     into the quota layer, which has no business making them.
 */
export const insertBatch = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    rows: v.array(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    await consumeQuotaForDataset(ctx, args.datasetId, args.rows.length);

    for (const data of args.rows) {
      await ctx.db.insert("datasetRows", {
        datasetId: args.datasetId,
        data,
      });
    }
  },
});
