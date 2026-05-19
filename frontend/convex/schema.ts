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
});
