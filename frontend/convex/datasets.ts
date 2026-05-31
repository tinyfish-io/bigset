import { query, mutation, internalQuery, internalMutation } from "./_generated/server.js";
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
  isPrimaryKey: v.optional(v.boolean()),
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
      .order("desc")
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

export const getInternal = internalQuery({
  args: { id: v.id("datasets") },
  handler: async (ctx, args) => {
    const dataset = await ctx.db.get(args.id);
    if (!dataset) throw new Error("Dataset not found");
    return dataset;
  },
});

export const beginPopulateInternal = internalMutation({
  args: {
    id: v.id("datasets"),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const dataset = await ctx.db.get(args.id);
    if (!dataset) {
      return { outcome: "not_found" as const };
    }
    if (dataset.ownerId !== args.ownerId) {
      return { outcome: "forbidden" as const };
    }
    if (dataset.status === "building") {
      return { outcome: "already_building" as const };
    }
    if (dataset.status === "updating") {
      return { outcome: "already_updating" as const };
    }
    await ctx.db.patch(dataset._id, {
      status: "building",
      lastStatusError: undefined,
    });
    return { outcome: "started" as const };
  },
});

export const beginUpdateInternal = internalMutation({
  args: {
    id: v.id("datasets"),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const dataset = await ctx.db.get(args.id);
    if (!dataset) {
      return { outcome: "not_found" as const };
    }
    if (dataset.ownerId !== args.ownerId) {
      return { outcome: "forbidden" as const };
    }
    if (dataset.status === "building") {
      return { outcome: "already_building" as const };
    }
    if (dataset.status === "updating") {
      return { outcome: "already_updating" as const };
    }
    await ctx.db.patch(dataset._id, {
      status: "updating",
      lastStatusError: undefined,
    });
    return { outcome: "started" as const };
  },
});

/**
 * Admin-only status transition. Used by the backend orchestration layer
 * to move a dataset between lifecycle states after a workflow completes.
 *
 * No authz check — the backend has already verified ownership before
 * reaching here (or is acting as the system on behalf of a scheduled
 * run). This mutation is purely a controlled patch on the `status` field.
 *
 * Lifecycle today:
 *   - "paused"   : default for newly created datasets before first run
 *   - "building" : set by beginPopulateInternal after ownership passes
 *   - "live"     : set by background populate after rows exist
 *   - "failed"   : set by background populate on workflow failure
 *
 * NOTE: the public `datasets.updateStatus` mutation still exists for
 * user-initiated transitions (Pause/Resume) — that one goes through
 * ownership authz. Use this internal version for system writes.
 */
export const setStatusInternal = internalMutation({
  args: {
    id: v.id("datasets"),
    status: v.union(
      v.literal("live"),
      v.literal("paused"),
      v.literal("building"),
      v.literal("updating"),
      v.literal("failed"),
    ),
    lastStatusError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: args.status,
      lastStatusError: args.status === "failed" ? args.lastStatusError : undefined,
    });
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    cadence: v.string(),
    columns: v.array(columnValidator),
    retrievalStrategy: v.optional(
      v.union(
        v.literal("search_fetch"),
        v.literal("browser"),
        v.literal("hybrid")
      )
    ),
    sourceHint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    assertNotReservedOwner(identity.subject);
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

export const updateDetails = mutation({
  args: {
    id: v.id("datasets"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const trimmedName = args.name.trim();
    if (!trimmedName) throw new Error("Dataset name cannot be empty");
    const dataset = await loadOwnedDataset(ctx, args.id);

    const nameChanged = trimmedName !== dataset.name;
    const descChanged = args.description !== undefined && args.description !== dataset.description;
    if (!nameChanged && !descChanged) return;

    const patch: Partial<Doc<"datasets">> = { name: trimmedName };
    if (descChanged) patch.description = args.description;
    await ctx.db.patch(dataset._id, patch);
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