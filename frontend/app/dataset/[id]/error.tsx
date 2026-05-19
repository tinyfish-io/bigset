"use client";

import { useEffect } from "react";
import Link from "next/link";
import { captureException } from "@/lib/analytics";

/**
 * Catches errors thrown by the Convex queries on /dataset/[id].
 *
 * The most common reason this fires is the authorization layer in
 * `convex/lib/authz.ts` throwing `Dataset not found` — either because the
 * id is invalid, the dataset was deleted, or the signed-in user doesn't
 * have access. We render the same message in all three cases on purpose:
 * distinguishing "doesn't exist" from "not yours" would leak existence.
 *
 * Reporting policy:
 *   - "Dataset not found" is an EXPECTED outcome (not a bug). Don't
 *     report to PostHog or we'd spam the error dashboard with normal
 *     authz rejections.
 *   - Anything else (rendering crash, network failure, etc.) IS a bug —
 *     report it with route context so it groups cleanly.
 */
export default function DatasetError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const msg = error?.message ?? "";
    const isExpected = /Dataset not found|Not authenticated|Row not found/.test(msg);
    if (!isExpected) {
      captureException(error, {
        source: "react.error_boundary",
        route: "/dataset/[id]",
        digest: error.digest,
      });
    }
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center max-w-sm">
        <p className="text-sm text-muted">Dataset not found.</p>
        <p className="mt-1 text-xs text-muted/70">
          It may have been deleted, or you may not have access.
        </p>
        <div className="mt-4 flex items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="text-sm font-semibold text-foreground hover:underline"
          >
            Back to dashboard
          </Link>
          <span className="text-foreground/15">·</span>
          <button
            onClick={reset}
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
