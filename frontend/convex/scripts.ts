import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import {
  nextRefreshAtFor,
} from "./lib/refreshScheduling.js";

export const SYSTEM_OWNER_ID = "system";

/**
 * Copy a public seed dataset (and its rows) to a new dataset owned by the
 * specified user.
 *
 * Run from the frontend/ directory:
 *
 *     npx convex run scripts:copySeedDatasetsToUser '{"userId": "user_123"}'
 *
 * Internal mutation (admin-key only): not callable from a browser.
 *
 * This is idempotent based on seedKey + userId combination: if the user
 * already has a copy of a given seed dataset, that dataset is skipped.
 */
export const copySeedDatasetsToUser = internalMutation({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = args;
    if (!userId) throw new Error("userId is required");

    const seedDatasets = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", SYSTEM_OWNER_ID))
      .collect();

    if (seedDatasets.length === 0) {
      return { copied: 0, skipped: 0, message: "No seed datasets found" };
    }

    const existingUserDatasets = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();

    const userSeedKeys = new Set(
      existingUserDatasets
        .filter((d) => d.seedKey)
        .map((d) => d.seedKey as string),
    );

    let copied = 0;
    let skipped = 0;

    for (const seedDataset of seedDatasets) {
      const seedKey = seedDataset.seedKey;
      if (!seedKey) {
        skipped++;
        continue;
      }

      if (userSeedKeys.has(seedKey)) {
        skipped++;
        continue;
      }

      const datasetId = await ctx.db.insert("datasets", {
        seedKey: seedKey,
        name: seedDataset.name,
        description: seedDataset.description ?? "",
        ownerId: userId,
        status: "live",
        refreshCadence: seedDataset.refreshCadence ?? "daily",
        refreshEnabled: seedDataset.refreshEnabled ?? true,
        nextRefreshAt: nextRefreshAtFor(
          seedDataset.refreshCadence ?? "daily",
          Date.now(),
        ),
        visibility: "private",
        columns: seedDataset.columns ?? [],
        rowCount: seedDataset.rowCount ?? 0,
      });

      const seedRows = await ctx.db
        .query("datasetRows")
        .withIndex("by_dataset", (q) => q.eq("datasetId", seedDataset._id))
        .collect();

      for (const row of seedRows) {
        await ctx.db.insert("datasetRows", {
          datasetId,
          data: row.data,
          sources: row.sources,
          rowSummary: row.rowSummary,
          howFound: row.howFound,
        });
      }

      if (seedRows.length > 0) {
        await ctx.db.patch(datasetId, { rowCount: seedRows.length });
      }

      copied++;
    }

    return {
      copied,
      skipped,
      total: seedDatasets.length,
    };
  },
});

/**
 * List all seed datasets (for debugging/verification).
 *
 *     npx convex run scripts:listSeedDatasets
 */
export const listSeedDatasets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const seedDatasets = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", SYSTEM_OWNER_ID))
      .collect();

    return seedDatasets.map((d) => ({
      _id: d._id,
      seedKey: d.seedKey,
      name: d.name,
      rowCount: d.rowCount,
    }));
  },
});

/**
 * Delete all datasets (and their rows) for a given user.
 * Useful for cleanup/testing.
 *
 *     npx convex run scripts:deleteAllUserDatasets '{"userId": "user_123"}'
 */
export const deleteAllUserDatasets = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const { userId } = args;

    const userDatasets = await ctx.db
      .query("datasets")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();

    let datasetsDeleted = 0;
    let rowsDeleted = 0;

    for (const dataset of userDatasets) {
      const rows = await ctx.db
        .query("datasetRows")
        .withIndex("by_dataset", (q) => q.eq("datasetId", dataset._id))
        .collect();

      for (const row of rows) {
        await ctx.db.delete(row._id);
        rowsDeleted++;
      }

      await ctx.db.delete(dataset._id);
      datasetsDeleted++;
    }

    return { datasetsDeleted, rowsDeleted };
  },
});
