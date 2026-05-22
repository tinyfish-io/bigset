import { query, mutation } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import {
  assertNotReservedOwner,
  loadOwnedDataset,
  loadReadableDataset,
  requireIdentity,
} from "./lib/authz.js";
import { requireQuotaRemaining } from "./lib/quota.js";

const columnValidator = v.object({
  name: v.string(),
  type: v.union(
    v.literal("text"),
    v.literal("number"),
    v.literal("boolean"),
    v.literal("url"),
    v.literal("date"),
  ),
  description: v.optional(v.string()),
});

const PREVIEW_ROW_COUNT = 5;

async function attachPreview(ctx: QueryCtx, dataset: Doc<"datasets">) {
  const rows = await ctx.db
    .query("datasetRows")
    .withIndex("by_dataset", (q) => q.eq("datasetId", dataset._id))
    .take(PREVIEW_ROW_COUNT);
  return {
    ...dataset,
    previewRows: rows.map((r) => r.data),
  };
}

/**
 * The signed-in user's own datasets, each with a small preview of rows.
 * Scoped by `ownerId === identity.subject`. Returns [] for users with no
 * datasets — never throws on empty.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);

    const datasets = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .collect();

    return Promise.all(datasets.map((ds) => attachPreview(ctx, ds)));
  },
});

/**
 * Curated public datasets, each with a small preview of rows. Callable
 * WITHOUT authentication — anonymous visitors on the landing page read
 * through this query.
 *
 * Scoped via `by_visibility` index so this stays O(public datasets), not
 * O(all datasets). Ordered by creation time descending so newer curated
 * datasets surface first.
 */
export const listPublic = query({
  args: {},
  handler: async (ctx) => {
    const datasets = await ctx.db
      .query("datasets")
      .withIndex("by_visibility", (q) => q.eq("visibility", "public"))
      .order("desc")
      .collect();

    return Promise.all(datasets.map((ds) => attachPreview(ctx, ds)));
  },
});

export const get = query({
  args: { id: v.id("datasets") },
  handler: async (ctx, args) => {
    return await loadReadableDataset(ctx, args.id);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    cadence: v.string(),
    columns: v.array(columnValidator),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    assertNotReservedOwner(identity.subject);
    // Block dataset creation at full exhaustion — a dataset you can't
    // populate is just clutter. Row generation later will re-check, so
    // this is a UX safeguard, not the only line of defense.
    await requireQuotaRemaining(ctx, identity.subject, 1);

    return await ctx.db.insert("datasets", {
      ...args,
      ownerId: identity.subject,
      status: "building",
      visibility: "private",
    });
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("datasets"),
    status: v.union(
      v.literal("live"),
      v.literal("paused"),
      v.literal("building"),
    ),
  },
  handler: async (ctx, args) => {
    const dataset = await loadOwnedDataset(ctx, args.id);
    await ctx.db.patch(dataset._id, { status: args.status });
  },
});

export const remove = mutation({
  args: { id: v.id("datasets") },
  handler: async (ctx, args) => {
    const dataset = await loadOwnedDataset(ctx, args.id);

    const rows = await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", dataset._id))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.delete(dataset._id);
  },
});
