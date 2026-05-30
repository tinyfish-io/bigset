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
      v.literal("building"),
      v.literal("updating"),
      v.literal("failed")
    ),
    lastStatusError: v.optional(v.string()),
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
    // Denormalized row count maintained by `datasetRows.insert / remove /
    // clearByDataset` and by the seed/create paths. Read by the dashboard
    // card's "X rows" footer via `datasets.attachPreview` so the count
    // stays reactive past the first PREVIEW_ROW_COUNT inserts (a query
    // over `.take(5)` only invalidates when one of the first 5 rows
    // changes, freezing the dashboard at 5). Optional for backward compat
    // with rows created before this field existed — write paths self-heal
    // on first hit, and `datasets.backfillRowCounts` migrates all at once.
    rowCount: v.optional(v.number()),
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
        isPrimaryKey: v.optional(v.boolean()),
      })
    ),
    retrievalStrategy: v.optional(
      v.union(
        v.literal("search_fetch"),
        v.literal("browser"),
        v.literal("hybrid")
      )
    ),
    sourceHint: v.optional(v.string()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_visibility", ["visibility"])
    .index("by_seed_key", ["seedKey"]),

  datasetRows: defineTable({
    datasetId: v.id("datasets"),
    data: v.record(v.string(), v.any()),
    sources: v.optional(v.array(v.string())),
    rowSummary: v.optional(v.string()),
    howFound: v.optional(v.string()),
    updateStatus: v.optional(v.literal("pending")),
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

  // One row per populate workflow run. Written once at the end of each run
  // (success or error) by the backend agent runner — never by the frontend.
  // Tracks tool-call counts, token usage, and timing so runs can be
  // compared across datasets, users, and benchmark sessions.
  runStats: defineTable({
    workflowRunId: v.string(),
    // v.string() (not v.id) so benchmark runs can use synthetic dataset ids
    // without needing a real Convex dataset document.
    datasetId: v.string(),
    userId: v.string(),
    startedAt: v.number(),
    finishedAt: v.number(),
    durationMs: v.number(),

    // Tool-call counts
    searchCalls: v.number(),
    fetchCalls: v.number(),
    investigateCalls: v.number(),
    rowsInserted: v.number(),

    // Token usage — totals across all agent invocations in this run
    tokensInput: v.number(),
    tokensOutput: v.number(),

    // Breakdown by agent tier
    orchestratorTokensInput: v.number(),
    orchestratorTokensOutput: v.number(),
    orchestratorSteps: v.number(),
    investigateTokensInput: v.number(),
    investigateTokensOutput: v.number(),
    investigateSteps: v.number(),
    investigateRuns: v.number(),

    status: v.union(v.literal("success"), v.literal("error")),
    error: v.optional(v.string()),

    // True when written by the benchmark runner rather than a real user session.
    isBenchmark: v.optional(v.boolean()),

    // "populate" = initial fill workflow; "update" = refresh/update workflow.
    // Optional for backward compat with rows written before this field existed
    // (treat missing as "populate").
    workflowType: v.optional(
      v.union(v.literal("populate"), v.literal("update"))
    ),
    // Rows successfully updated by the refresh agent (update workflow only).
    rowsUpdated: v.optional(v.number()),
  })
    .index("by_dataset", ["datasetId"])
    .index("by_user", ["userId"])
    .index("by_workflow_run", ["workflowRunId"]),
});
