"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useUser } from "@clerk/nextjs";
import { identify, initAnalytics, reset } from "./analytics";

/**
 * Mounts PostHog and bridges Clerk's auth state into PostHog identity.
 *
 * Lives inside `ClerkProvider` so `useUser()` resolves. Children render
 * normally — this provider has no UI, it's just a side-effect carrier.
 *
 * Identity transitions handled:
 *   1. Initial load, signed-in user:    identify()
 *   2. Anonymous → sign-in:             identify() (PostHog auto-aliases
 *                                        the anon distinct_id to userId)
 *   3. Signed-in → sign-out:            reset() (new anon session,
 *                                        no cross-account contamination)
 *   4. Same user reloads:               identify() again (idempotent)
 *
 * The `wasSignedIn` ref distinguishes "user just signed out" (call reset)
 * from "user was never signed in" (do nothing — keep the anon session).
 * Without it, the first render with isSignedIn=false would call reset()
 * and break anonymous-event attribution.
 */
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const wasSignedIn = useRef<boolean>(false);

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    if (isSignedIn && user) {
      identify(user.id, {
        email: user.primaryEmailAddress?.emailAddress,
      });
    } else if (wasSignedIn.current) {
      reset();
    }

    wasSignedIn.current = !!isSignedIn;
  }, [isLoaded, isSignedIn, user?.id, user?.primaryEmailAddress?.emailAddress]);

  return <>{children}</>;
}
