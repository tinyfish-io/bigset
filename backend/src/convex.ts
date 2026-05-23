import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

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
 * `anyApi` is an untyped proxy that resolves function references at runtime.
 * Full types come from the frontend's generated code (included via tsconfig)
 * and are available in the IDE, but the Docker container doesn't need them.
 */
export const api = anyApi;
export const internal = anyApi;

export const convex = new ConvexHttpClient(env.CONVEX_URL);

if (env.CONVEX_ADMIN_KEY) {
  convex.setAdminAuth(env.CONVEX_ADMIN_KEY);
}
