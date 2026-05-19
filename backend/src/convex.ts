import { ConvexHttpClient } from "convex/browser";

import { env } from "./env.js";

/**
 * Convex client for SYSTEM-LEVEL operations from the backend.
 *
 * Authenticated with the Convex self-hosted admin key, which:
 *   - bypasses `ctx.auth.getUserIdentity()` checks (admin = trusted system)
 *   - is the only way to call functions marked `internalMutation` /
 *     `internalQuery` / `internalAction`
 *
 * Use this client for:
 *   ✓ Agent runner writing dataset rows (datasetRows.insert is internal)
 *   ✓ Scheduled cadence-driven refreshes
 *   ✗ NEVER use this to act "on behalf of a user". For user-initiated work,
 *     the frontend should call Convex directly with the user's Clerk JWT.
 *
 * If admin key is missing, this client can still call PUBLIC functions but
 * will fail closed on internal ones (which is the desired behavior — better
 * to error than to silently degrade).
 */
export { api, internal } from "../../frontend/convex/_generated/api.js";

export const convex = new ConvexHttpClient(env.CONVEX_URL);

if (env.CONVEX_ADMIN_KEY) {
  convex.setAdminAuth(env.CONVEX_ADMIN_KEY);
}
