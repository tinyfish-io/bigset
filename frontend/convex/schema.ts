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
  }).index("by_owner", ["ownerId"]),

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
