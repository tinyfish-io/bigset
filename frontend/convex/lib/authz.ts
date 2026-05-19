import type {
  GenericQueryCtx,
  GenericMutationCtx,
  UserIdentity,
} from "convex/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel.js";

/**
 * Centralized authorization for all dataset access.
 *
 * Every Convex function that reads or writes a dataset (or its rows) goes
 * through one of the helpers in this file. Inline auth checks elsewhere are
 * a code smell — add a helper here instead.
 *
 * Public-vs-private semantics:
 *   - Datasets without a `visibility` field are treated as PRIVATE (backward
 *     compat with rows created before the field existed).
 *   - `loadReadable*` allows owner OR public; used by reads.
 *   - `loadOwned*` requires owner; used by mutations.
 *
 * Error policy:
 *   - Client-facing error is always the same: `DATASET_NOT_FOUND`.
 *     Distinct messages create an existence oracle (an attacker could probe
 *     for valid IDs they don't own).
 *   - Server-facing logs are detailed. They show up in the Convex dashboard
 *     and are correlated by request ID. Engineers can debug; clients see
 *     nothing differentiating.
 */

type AnyCtx =
  | GenericQueryCtx<DataModel>
  | GenericMutationCtx<DataModel>;

const DATASET_NOT_FOUND = "Dataset not found";
const UNAUTHENTICATED = "Not authenticated";

/**
 * Owner-id values reserved for system-managed datasets (e.g. curated
 * public content). No human user can hold one of these; if Clerk ever
 * mints a subject that collides, we fail closed.
 *
 * Add new sentinels here when introducing new system roles (e.g.
 * "admin-curator" once a curator dashboard exists).
 */
export const RESERVED_OWNER_IDS: ReadonlySet<string> = new Set(["system"]);

export function isReservedOwnerId(ownerId: string): boolean {
  return RESERVED_OWNER_IDS.has(ownerId);
}

/**
 * Defense-in-depth: refuse to attach a reserved owner id to any dataset
 * created via a user-facing mutation. Today this can never fire (Clerk
 * subjects are `user_<27 chars>`); it exists so that a future bug — an
 * argument-driven `ownerId`, a Clerk format change, an admin pretending
 * to be the system — can't quietly collide with curated content.
 */
export function assertNotReservedOwner(ownerId: string): void {
  if (isReservedOwnerId(ownerId)) {
    console.error(
      `[authz] refused to create dataset with reserved ownerId='${ownerId}'`,
    );
    throw new Error(UNAUTHENTICATED);
  }
}

type AuthzDenyReason =
  | "unauthenticated"
  | "anonymous_private"
  | "wrong_owner"
  | "missing_dataset"
  | "missing_row";

function logDeny(
  reason: AuthzDenyReason,
  details: {
    datasetId?: Id<"datasets">;
    rowId?: Id<"datasetRows">;
    callerSubject?: string;
    ownerId?: string;
    op: "read" | "write";
  },
): void {
  const caller = details.callerSubject ?? "anonymous";
  const target = details.datasetId ?? details.rowId ?? "<none>";
  const owner = details.ownerId ?? "<n/a>";
  console.warn(
    `[authz] deny op=${details.op} reason=${reason} caller=${caller} target=${target} owner=${owner}`,
  );
}

export async function requireIdentity(ctx: AnyCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    logDeny("unauthenticated", { op: "write" });
    throw new Error(UNAUTHENTICATED);
  }
  return identity;
}

export async function getIdentity(
  ctx: AnyCtx,
): Promise<UserIdentity | null> {
  return await ctx.auth.getUserIdentity();
}

function isPublic(dataset: Doc<"datasets">): boolean {
  return dataset.visibility === "public";
}

function isOwner(
  dataset: Doc<"datasets">,
  identity: UserIdentity | null,
): boolean {
  return identity !== null && dataset.ownerId === identity.subject;
}

/**
 * Load a dataset that the caller is allowed to MUTATE.
 *
 * Authenticated + must be owner. Used for updateStatus, remove, and any
 * future write paths. Public datasets are NOT writable except by their
 * owner — and since curated public datasets are owned by the `system`
 * sentinel (see RESERVED_OWNER_IDS), no human user can mutate them.
 */
export async function loadOwnedDataset(
  ctx: AnyCtx,
  datasetId: Id<"datasets">,
): Promise<Doc<"datasets">> {
  const identity = await requireIdentity(ctx);
  const dataset = await ctx.db.get(datasetId);
  if (!dataset) {
    logDeny("missing_dataset", {
      datasetId,
      callerSubject: identity.subject,
      op: "write",
    });
    throw new Error(DATASET_NOT_FOUND);
  }
  if (!isOwner(dataset, identity)) {
    logDeny("wrong_owner", {
      datasetId,
      callerSubject: identity.subject,
      ownerId: dataset.ownerId,
      op: "write",
    });
    throw new Error(DATASET_NOT_FOUND);
  }
  return dataset;
}

/**
 * Load a dataset that the caller is allowed to READ.
 *
 * Allows: signed-in owner, OR any caller — including unauthenticated — if
 * the dataset is public. Used for `datasets.get` and
 * `datasetRows.listByDataset`.
 */
export async function loadReadableDataset(
  ctx: AnyCtx,
  datasetId: Id<"datasets">,
): Promise<Doc<"datasets">> {
  const dataset = await ctx.db.get(datasetId);
  if (!dataset) {
    const identity = await getIdentity(ctx);
    logDeny("missing_dataset", {
      datasetId,
      callerSubject: identity?.subject,
      op: "read",
    });
    throw new Error(DATASET_NOT_FOUND);
  }

  if (isPublic(dataset)) return dataset;

  const identity = await getIdentity(ctx);
  if (!identity) {
    logDeny("anonymous_private", {
      datasetId,
      ownerId: dataset.ownerId,
      op: "read",
    });
    throw new Error(DATASET_NOT_FOUND);
  }
  if (!isOwner(dataset, identity)) {
    logDeny("wrong_owner", {
      datasetId,
      callerSubject: identity.subject,
      ownerId: dataset.ownerId,
      op: "read",
    });
    throw new Error(DATASET_NOT_FOUND);
  }
  return dataset;
}

/**
 * Load a dataset ROW that the caller is allowed to READ, plus its parent
 * dataset. Used by any future query that returns row-scoped data
 * (datasetHistory timelines, single-row inspection, etc.).
 *
 * Calling shape:
 *   const { row, dataset } = await loadReadableRow(ctx, rowId);
 *
 * Returns both because callers usually want at least one. Single roundtrip,
 * one auth decision, no duplication.
 */
export async function loadReadableRow(
  ctx: AnyCtx,
  rowId: Id<"datasetRows">,
): Promise<{ row: Doc<"datasetRows">; dataset: Doc<"datasets"> }> {
  const row = await ctx.db.get(rowId);
  if (!row) {
    const identity = await getIdentity(ctx);
    logDeny("missing_row", {
      rowId,
      callerSubject: identity?.subject,
      op: "read",
    });
    throw new Error(DATASET_NOT_FOUND);
  }
  const dataset = await loadReadableDataset(ctx, row.datasetId);
  return { row, dataset };
}
