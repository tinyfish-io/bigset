"use client";

import { useEffect } from "react";
import Link from "next/link";
import { captureException } from "@/lib/analytics";

/**
 * Root-level error boundary. Catches React rendering crashes anywhere
 * inside the root layout — e.g. an unexpected `undefined.x` in a page
 * component, a Convex query that throws, a hook that crashes.
 *
 * Layout providers (Clerk, Convex, AnalyticsProvider) are STILL mounted
 * when this renders. That means `captureException` works, identity is
 * preserved, and the page chrome (header, nav) is unaffected.
 *
 * For errors so catastrophic they break the layout itself, see
 * app/global-error.tsx (last-resort boundary).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      source: "react.error_boundary",
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-20">
      <div className="text-center max-w-sm space-y-4">
        <p className="text-sm font-semibold text-foreground">
          Something went wrong.
        </p>
        <p className="text-xs text-muted leading-relaxed">
          The error has been reported. You can try again or head back to the
          dashboard.
        </p>
        <div className="flex items-center justify-center gap-4 pt-2">
          <button
            onClick={reset}
            className="border border-accent bg-accent px-4 py-2 text-xs font-semibold text-accent-text transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
