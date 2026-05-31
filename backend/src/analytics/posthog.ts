import { PostHog } from "posthog-node";
import { env } from "../env.js";
import type { BackendEventName } from "./events.js";

/**
 * Server-side PostHog wrapper.
 *
 * Why a separate module from the frontend's `lib/analytics.ts`:
 *   - The backend fires events the frontend can't observe (e.g. the
 *     email actually being accepted by Resend, server-only failures).
 *   - Same PostHog project; same `phc_...` key. Events keyed by the
 *     Clerk userId associate to the same person the frontend already
 *     identified via `analytics-provider.tsx`.
 *
 * Behavior:
 *   - No-op when `POSTHOG_KEY` is unset (local dev without an account).
 *   - `flushAt: 1` ships events immediately. Low volume, simpler reasoning;
 *     no buffered events sitting in memory across restarts.
 *   - All `capture` calls are wrapped in try/catch — analytics failures
 *     must NEVER affect the request that triggered them.
 */

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (client) return client;
  if (!env.POSTHOG_KEY) return null;
  client = new PostHog(env.POSTHOG_KEY, {
    host: env.POSTHOG_HOST,
    flushAt: 1,
  });
  return client;
}

export function isAnalyticsEnabled(): boolean {
  return Boolean(env.POSTHOG_KEY);
}

/**
 * Fire an event keyed to a Clerk user id. Safe to call without checking
 * `isAnalyticsEnabled()` first — no-ops cleanly when disabled.
 */
export function capture(params: {
  distinctId: string;
  event: BackendEventName;
  properties?: Record<string, unknown>;
}): void {
  const c = getClient();
  if (!c) return;
  try {
    c.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties,
    });
  } catch (err) {
    console.error("[analytics] capture failed", err);
  }
}

/**
 * Flush pending events. Wire into Fastify's `onClose` so SIGTERM doesn't
 * drop in-flight captures.
 */
export async function shutdown(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    console.error("[analytics] shutdown failed", err);
  }
}
