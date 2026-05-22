import { query } from "./_generated/server.js";
import { getUsageFor } from "./lib/quota.js";
import { requireIdentity } from "./lib/authz.js";

/**
 * Read-only snapshot of the signed-in user's quota usage. Used by the
 * dashboard's QuotaBadge component.
 *
 * Returns `{ consumed, limit, remaining, fractionUsed }`. The limit is
 * returned alongside `consumed` so the UI never hardcodes the constant —
 * when paid plans land, the limit becomes per-user and this query is the
 * single source of truth.
 */
export const getMy = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    return await getUsageFor(ctx, identity.subject);
  },
});
