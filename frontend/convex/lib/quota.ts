import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel.js";
import { isReservedOwnerId } from "./authz.js";

/**
 * Per-principal quota enforcement for row modifications.
 *
 * One counter per principal (the `usage` table). Free tier is currently
 * 2,500 row operations PER MONTH (calendar month, UTC). The counter resets
 * lazily — the next read or write after the 1st of a new month rolls the
 * counter back to 0. No background job needed.
 *
 * Charging model:
 *   - 1 row inserted, updated, or replaced = 1 unit consumed this period
 *   - System-owned datasets (ownerId === "system") bypass quota entirely
 *   - Deletes do NOT refund; the counter tracks WORK in the period, not
 *     current row count. Deletion is just cleanup.
 *   - Period rolls over on the 1st (UTC) of each calendar month
 *
 * Principal model:
 *   - Today: the principal is `dataset.ownerId`, which is a Clerk user id
 *   - Future (orgs/teams): the principal can also be a Clerk `org_xxx` id;
 *     this module already resolves the principal through the dataset, so
 *     a future schema change that lets datasets be owned by an org will
 *     "just work" — `usage.userId` should be read as "principalId"
 *
 * Atomicity:
 *   - Convex mutations are atomic. `consumeQuota` + the actual row write
 *     happen in one transaction, so failed writes never charge the user.
 *   - Concurrent agent calls on the same principal serialize via the
 *     `usage` doc (Convex retries on optimistic-concurrency conflict).
 *
 * Architectural boundary with the agent runner:
 *   - The quota layer's job is HARD ENFORCEMENT — yes/no, atomic, simple.
 *   - The agent layer's job is BATCH SIZING — call `getUsageFor` first,
 *     split work to fit `remaining`, drive the retry/backoff strategy.
 *   - `insertBatch` is intentionally all-or-nothing: a partial accept
 *     would leak quota-aware policy ("which rows survived?") into the
 *     quota layer, which has no business making that decision.
 */

type AnyCtx =
  | GenericQueryCtx<DataModel>
  | GenericMutationCtx<DataModel>;
type WriteCtx = GenericMutationCtx<DataModel>;

/**
 * Monthly free-tier limit. Hardcoded today; will move onto the `usage`
 * row (`plan` field + lookup table) when paid tiers exist.
 */
export const FREE_TIER_MONTHLY_QUOTA = 2500;

export class QuotaExceededError extends Error {
  constructor(consumed: number, limit: number, requested: number) {
    super(
      `Monthly free-tier quota exceeded: ${consumed}/${limit} used this period, ${requested} more requested`,
    );
    this.name = "QuotaExceededError";
  }
}

export interface UsageSnapshot {
  consumed: number;
  limit: number;
  remaining: number;
  /** 0..1 fraction. Capped at 1 for display purposes. */
  fractionUsed: number;
  /** ms epoch of the start of the current billing period (1st of month UTC). */
  periodStart: number;
  /** ms epoch when the current period ends (1st of next month UTC). */
  periodEndsAt: number;
}

/**
 * First-millisecond of the UTC calendar month containing `ts`.
 * Pure function; internal helper.
 */
function getMonthStartUTC(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** First-millisecond of the UTC calendar month AFTER the one containing `ts`. */
function getNextMonthStartUTC(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function snapshotOf(consumed: number, periodStart: number): UsageSnapshot {
  const remaining = Math.max(0, FREE_TIER_MONTHLY_QUOTA - consumed);
  const fractionUsed = Math.min(1, consumed / FREE_TIER_MONTHLY_QUOTA);
  return {
    consumed,
    limit: FREE_TIER_MONTHLY_QUOTA,
    remaining,
    fractionUsed,
    periodStart,
    periodEndsAt: getNextMonthStartUTC(periodStart),
  };
}

/**
 * Read-only snapshot for UI rendering. Returns a zero-state snapshot if
 * the user has no usage row yet OR if the existing row belongs to a past
 * period (no DB write — the actual reset happens on the next consumeQuota
 * call).
 */
export async function getUsageFor(
  ctx: AnyCtx,
  userId: string,
): Promise<UsageSnapshot> {
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  const monthStart = getMonthStartUTC(Date.now());

  // Either no row yet, or row belongs to a previous period → show 0.
  // (The DB row is left alone here; the next write rolls it over.)
  if (!row || (row.periodStart ?? 0) < monthStart) {
    return snapshotOf(0, monthStart);
  }
  return snapshotOf(row.rowsConsumed, row.periodStart ?? monthStart);
}

/**
 * Pre-flight check used by `datasets.create`: rejects the call if the
 * user has zero quota left in the current period. We block dataset
 * creation at full exhaustion because a dataset you can't populate is
 * just clutter.
 */
export async function requireQuotaRemaining(
  ctx: AnyCtx,
  userId: string,
  atLeast: number = 1,
): Promise<void> {
  const usage = await getUsageFor(ctx, userId);
  if (usage.remaining < atLeast) {
    throw new QuotaExceededError(usage.consumed, usage.limit, atLeast);
  }
}

/**
 * Atomically check + consume `n` units against `dataset.ownerId` for the
 * CURRENT period. Performs the monthly rollover if the existing row
 * belongs to a past period.
 *
 * Call this BEFORE the row write inside the same mutation. If quota is
 * exceeded, throws (the row write never happens, transaction rolls back).
 * System-owned datasets pass through with no accounting.
 */
export async function consumeQuota(
  ctx: WriteCtx,
  dataset: Doc<"datasets">,
  n: number,
): Promise<void> {
  if (n <= 0) return;
  if (isReservedOwnerId(dataset.ownerId)) return;

  const userId = dataset.ownerId;
  const monthStart = getMonthStartUTC(Date.now());

  const row = await ctx.db
    .query("usage")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  // Rollover if the existing row belongs to a past period.
  const carryConsumed =
    row && (row.periodStart ?? 0) >= monthStart ? row.rowsConsumed : 0;
  const next = carryConsumed + n;

  if (next > FREE_TIER_MONTHLY_QUOTA) {
    throw new QuotaExceededError(carryConsumed, FREE_TIER_MONTHLY_QUOTA, n);
  }

  if (row) {
    await ctx.db.patch(row._id, {
      rowsConsumed: next,
      periodStart: monthStart,
    });
  } else {
    await ctx.db.insert("usage", {
      userId,
      rowsConsumed: next,
      periodStart: monthStart,
    });
  }
}

/**
 * Resolve a row's parent dataset and consume `n` against its owner.
 * Used by `datasetRows.update`, which only knows the rowId up front.
 */
export async function consumeQuotaForRow(
  ctx: WriteCtx,
  rowId: Id<"datasetRows">,
  n: number,
): Promise<Doc<"datasetRows">> {
  const row = await ctx.db.get(rowId);
  if (!row) throw new Error("Row not found");
  const dataset = await ctx.db.get(row.datasetId);
  if (!dataset) throw new Error("Dataset not found");
  await consumeQuota(ctx, dataset, n);
  return row;
}

/**
 * Resolve a dataset by id (used by row writes that take datasetId) and
 * consume `n` against its owner. Returns the dataset for callers that
 * also need it.
 */
export async function consumeQuotaForDataset(
  ctx: WriteCtx,
  datasetId: Id<"datasets">,
  n: number,
): Promise<Doc<"datasets">> {
  const dataset = await ctx.db.get(datasetId);
  if (!dataset) throw new Error("Dataset not found");
  await consumeQuota(ctx, dataset, n);
  return dataset;
}
