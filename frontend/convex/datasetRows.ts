import { query, internalMutation, internalQuery } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { assertRowInDataset, loadReadableDataset } from "./lib/authz.js";
import { consumeQuotaForDataset } from "./lib/quota.js";

/**
 * Authoritative row count for a dataset. O(N), so use only on the slow
 * paths: self-heal in `insert` / `remove` when the dataset doc predates
 * the `rowCount` field, or the explicit `datasets.backfillRowCounts`
 * migration. Steady-state writes hit the cached counter and never call
 * this.
 */
async function actualRowCount(
  ctx: MutationCtx,
  datasetId: Id<"datasets">,
): Promise<number> {
  const rows = await ctx.db
    .query("datasetRows")
    .withIndex("by_dataset", (q) => q.eq("datasetId", datasetId))
    .collect();
  return rows.length;
}

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
    // `consumeQuotaForDataset` returns the dataset doc so we don't
    // double-read it.
    const dataset = await consumeQuotaForDataset(ctx, args.datasetId, 1);

    // Pre-insert count is either the cached counter (fast path) or — for
    // datasets whose docs predate the rowCount field — recomputed once
    // here. Subsequent inserts on the same dataset hit the fast path.
    const previousCount =
      typeof dataset.rowCount === "number"
        ? dataset.rowCount
        : await actualRowCount(ctx, args.datasetId);

    const rowId = await ctx.db.insert("datasetRows", args);

    // Maintain the denormalized counter the dashboard reads from. Same
    // transaction as the row insert → atomic; quota-rejected inserts
    // never bump the counter.
    await ctx.db.patch(args.datasetId, { rowCount: previousCount + 1 });

    return rowId;
  },
});

/**
 * Update a row by id. Capability-scoped: the caller MUST pass the
 * dataset this row is expected to belong to. If the row doesn't exist
 * or belongs to a different dataset, throws `"Row not found"` (uniform
 * with the existence-oracle policy in lib/authz.ts).
 *
 * Why `expectedDatasetId` is required, not optional:
 *   - The only callers are system-trusted code paths (the populate agent,
 *     future scheduled refreshers). Each operates with a single
 *     authorized dataset in scope.
 *   - Making it required forces every caller to think about which
 *     dataset they're writing to. A future caller that forgot the scope
 *     hits a TypeScript error, not a security hole.
 */
export const update = internalMutation({
  args: {
    id: v.id("datasetRows"),
    expectedDatasetId: v.id("datasets"),
    data: v.record(v.string(), v.any()),
  },
  handler: async (ctx, args) => {
    // 1. Capability scope check (security): atomically verifies the row
    //    exists AND belongs to expectedDatasetId. Throws otherwise.
    const existing = await assertRowInDataset(
      ctx,
      args.id,
      args.expectedDatasetId,
    );

    // 2. Quota: charge the dataset's owner for 1 row modification.
    await consumeQuotaForDataset(ctx, args.expectedDatasetId, 1);

    // 3. Diff + history.
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

    // 4. Patch.
    await ctx.db.patch(args.id, { data: newData });
  },
});

/**
 * Atomically merge new values into an existing row using per-field rules:
 *
 *   • Blank cells  → always filled with any non-empty incoming value,
 *                    regardless of confidence. A higher-confidence partial
 *                    row must never block a lower-confidence agent from
 *                    filling columns that are still empty.
 *   • Non-blank cells → only overwritten when newConfidence > existing
 *                       row confidence (authoritative source wins).
 *
 * Why this lives in Convex and not in the tool layer:
 *   The tool's in-memory rowIndex is stale during parallel agent runs.
 *   Two concurrent investigate agents can both pass a client-side
 *   confidence check against the same cached value, then race to write —
 *   the slower, lower-confidence write can win. Performing the compare-
 *   and-merge atomically inside a single Convex transaction eliminates
 *   that window: each write reads the *committed* current state before
 *   deciding what to change.
 *
 * Returns { merged: true } if at least one field was written, or
 * { merged: false } when no field satisfied the merge rules (no-op).
 * Quota is only charged on actual changes.
 */
export const mergeUpdate = internalMutation({
  args: {
    id: v.id("datasetRows"),
    expectedDatasetId: v.id("datasets"),
    /** Column values the caller wants to write. Internal _-prefixed keys are ignored. */
    newData: v.record(v.string(), v.any()),
    /** Caller's source confidence 0–1 (1.0 = primary source, 0.5 = aggregator). */
    newConfidence: v.number(),
    /** Optional per-column source URLs to merge into _sources. */
    newSources: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await assertRowInDataset(ctx, args.id, args.expectedDatasetId);
    const existingData = existing.data as Record<string, unknown>;
    const existingConfidence =
      typeof existingData._confidence === "number" ? existingData._confidence : 0;

    // Pass 1: determine which fields will actually change.
    type FieldChange = { key: string; oldVal: string; newVal: unknown };
    const changedFields: FieldChange[] = [];
    const mergedData: Record<string, unknown> = { ...existingData };

    for (const [key, newVal] of Object.entries(args.newData)) {
      if (key.startsWith("_")) continue; // internal fields handled below
      if (newVal === null || newVal === undefined || newVal === "") continue; // never write blanks

      const existingVal = existingData[key];
      const existingIsBlank =
        existingVal === null || existingVal === undefined || existingVal === "";

      if (existingIsBlank || args.newConfidence > existingConfidence) {
        if (String(existingVal ?? "") !== String(newVal)) {
          changedFields.push({ key, oldVal: String(existingVal ?? ""), newVal });
          mergedData[key] = newVal;
        }
      }
    }

    if (changedFields.length === 0) return { merged: false };

    // Charge quota only when we actually change something.
    await consumeQuotaForDataset(ctx, args.expectedDatasetId, 1);

    // Record history for each changed field.
    for (const { key, oldVal, newVal } of changedFields) {
      await ctx.db.insert("datasetHistory", {
        datasetRowId: args.id,
        columnName: key,
        oldValue: oldVal,
        newValue: String(newVal),
        changedAt: Date.now(),
      });
    }

    // Update internal housekeeping fields.
    mergedData._confidence = Math.max(existingConfidence, args.newConfidence);
    if (args.newSources) {
      const existingSources =
        (existingData._sources as Record<string, string> | undefined) ?? {};
      mergedData._sources = { ...existingSources, ...args.newSources };
    }

    await ctx.db.patch(args.id, { data: mergedData });
    return { merged: true };
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
    // Reset the cached counter. We know the post-state exactly, so this
    // doesn't need the read-then-add dance that `insert` / `remove` use.
    await ctx.db.patch(args.datasetId, { rowCount: 0 });
    return rows.length;
  },
});

export const get = internalQuery({
  args: { id: v.id("datasetRows") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Admin-only row count for a dataset. Used by the backend after a populate
 * workflow completes to decide whether to send the "Your dataset is ready"
 * email — only sent when at least one row exists.
 *
 * Exposed as `internalQuery` rather than reusing `api.datasetRows.listByDataset`
 * because that query runs through `loadReadableDataset` which requires
 * either ownership or visibility="public" — neither holds when the backend
 * uses admin auth without an identity context.
 */
export const countByDataset = internalQuery({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
    return rows.length;
  },
});

/**
 * Delete a row by id. Capability-scoped just like `update` above: caller
 * MUST pass the dataset this row is expected to belong to. Throws
 * `"Row not found"` if the row is missing or lives in a different dataset
 * (uniform error — no existence oracle for prompt-injected models).
 *
 * Deletions are NOT quota-charged: quota measures generative cost (rows
 * the agent had to discover + author), not cleanup. A user-facing future
 * caller could still apply its own quota policy.
 */
export const remove = internalMutation({
  args: {
    id: v.id("datasetRows"),
    expectedDatasetId: v.id("datasets"),
  },
  handler: async (ctx, args) => {
    await assertRowInDataset(ctx, args.id, args.expectedDatasetId);

    // Decrement the cached counter, self-healing if the dataset doc
    // predates the rowCount field. `dataset` is guaranteed to exist —
    // assertRowInDataset above verified the row belongs to it.
    const dataset = await ctx.db.get(args.expectedDatasetId);
    if (dataset) {
      const previousCount =
        typeof dataset.rowCount === "number"
          ? dataset.rowCount
          : await actualRowCount(ctx, args.expectedDatasetId);
      await ctx.db.patch(args.expectedDatasetId, {
        // clamp at 0 as a paranoid guard — counter should never go
        // negative because we just confirmed the row exists, but a bug
        // that drove it negative would manifest as an even weirder UI.
        rowCount: Math.max(0, previousCount - 1),
      });
    }

    await ctx.db.delete(args.id);
  },
});

/**
 * Delete rows from a dataset that are incomplete — i.e. any row where at
 * least one of the required column names is missing, null, or an empty
 * string in its data record.
 *
 * Called by the backend after the populate workflow completes so that only
 * fully-filled rows appear in the live dataset. Best-effort: the backend
 * catches and logs failures rather than failing the whole populate response.
 *
 * columnNames must be the FULL list of required columns for this dataset
 * (not a subset). Internal _-prefixed fields (e.g. _confidence, _sources)
 * are never treated as required columns.
 *
 * Returns { deletedCount } for backend logging.
 */
export const deleteIncomplete = internalMutation({
  args: {
    datasetId: v.id("datasets"),
    columnNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();

    let deletedCount = 0;
    for (const row of rows) {
      const data = row.data as Record<string, unknown>;
      const isComplete = args.columnNames.every((col) => {
        if (col.startsWith("_")) return true; // skip internal fields (_confidence, _sources, etc.)
        const val = data[col];
        return val !== null && val !== undefined && val !== "";
      });
      if (!isComplete) {
        await ctx.db.delete(row._id);
        deletedCount++;
      }
    }
    return { deletedCount };
  },
});

/**
 * Admin-only row listing for a dataset. Used by the populate agent's
 * `list_rows` tool to see what's already been inserted in the dataset
 * it's authorized for (so the LLM can diff/append rather than dup).
 *
 * Exposed as `internalQuery` for the same reason as `countByDataset`:
 * the backend has admin auth but no user identity, so the public
 * `listByDataset` (which goes through `loadReadableDataset`) would
 * reject it as `anonymous_private`.
 *
 * Caller is responsible for passing the dataset id it's scoped to —
 * at the tool layer, that id is captured by closure, not LLM-supplied,
 * so the agent can't read other users' rows even via prompt injection.
 */
export const listInternal = internalQuery({
  args: { datasetId: v.id("datasets") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("datasetRows")
      .withIndex("by_dataset", (q) => q.eq("datasetId", args.datasetId))
      .collect();
  },
});

