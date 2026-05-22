import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  datasets: defineTable({
    name: v.string(),
    description: v.string(),
    ownerId: v.string(),
    status: v.union(
      v.literal("live"),
      v.literal("paused"),
      v.literal("building")
    ),
    cadence: v.string(),
    // Optional for backward compat with rows seeded before this field existed.
    // Treat undefined as "private" in authorization helpers.
    visibility: v.optional(
      v.union(v.literal("public"), v.literal("private"))
    ),
    // Stable identifier for system-managed/curated datasets so dedup at seed
    // time doesn't rely on `name` (which marketing changes). User-created
    // datasets do not set this. See convex/publicSeed.ts.
    seedKey: v.optional(v.string()),
    columns: v.array(
      v.object({
        name: v.string(),
        type: v.union(
          v.literal("text"),
          v.literal("number"),
          v.literal("boolean"),
          v.literal("url"),
          v.literal("date")
        ),
        description: v.optional(v.string()),
      })
    ),
  })
    .index("by_owner", ["ownerId"])
    .index("by_visibility", ["visibility"])
    .index("by_seed_key", ["seedKey"]),

  datasetRows: defineTable({
    datasetId: v.id("datasets"),
    data: v.record(v.string(), v.any()),
    sources: v.optional(v.array(v.string())),
    scrapeScript: v.optional(v.string()),
  }).index("by_dataset", ["datasetId"]),

  datasetHistory: defineTable({
    datasetRowId: v.id("datasetRows"),
    columnName: v.string(),
    oldValue: v.string(),
    newValue: v.string(),
    changedAt: v.number(),
  }).index("by_row", ["datasetRowId"]),

  // Per-user / per-account quota accounting. One row per principal, created
  // lazily on first row modification. `rowsConsumed` tracks WORK done in
  // the current period — deleting rows does NOT refund quota.
  //
  // Period model: calendar month, UTC. Rolls over on the 1st (UTC) of each
  // month — the helper detects rollover lazily on the next read/write and
  // resets the counter without a background job.
  //
  // The `userId` field is named for the current scope (per-Clerk-user) but
  // semantically holds any principal id — when Clerk Organizations land,
  // an `org_xxx` id will live here too without a schema change. See
  // convex/lib/quota.ts for the resolution policy.
  //
  // Future fields (all optional → no migration needed when added):
  //   - plan: "free" | "pro" | "enterprise" (today: implicitly "free")
  //   - limitOverride (admin grants beyond plan default)
  usage: defineTable({
    userId: v.string(),
    rowsConsumed: v.number(),
    // ms epoch of the start of the period this counter belongs to (first
    // ms of the current UTC calendar month). Optional for forward-compat
    // with rows written before this field existed — missing = treated as
    // "before current period", which forces a reset on next write.
    periodStart: v.optional(v.number()),
  }).index("by_user", ["userId"]),
});
