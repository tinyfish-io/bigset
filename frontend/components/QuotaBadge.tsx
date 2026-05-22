"use client";

import { useQuery, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Compact usage indicator in the dashboard header.
 *
 * Three visual states, all derived from server-returned usage so paid
 * plans / per-user limits "just work" with no UI change:
 *
 *   <80%   muted text, neutral border
 *   80–99% amber border + amber text
 *   100%   red border + red text
 *
 * Hidden for anonymous viewers — the badge is account-scoped.
 */
export function QuotaBadge() {
  const { isAuthenticated } = useConvexAuth();
  const usage = useQuery(
    api.quota.getMy,
    isAuthenticated ? {} : "skip",
  );

  if (!isAuthenticated || !usage) return null;

  const exhausted = usage.remaining === 0;
  const warning = !exhausted && usage.fractionUsed >= 0.8;
  const resetLabel = formatResetDate(usage.periodEndsAt);

  const borderClass = exhausted
    ? "border-red-500/40"
    : warning
      ? "border-amber-500/40"
      : "border-border";

  const textClass = exhausted
    ? "text-red-600 dark:text-red-400"
    : warning
      ? "text-amber-700 dark:text-amber-400"
      : "text-muted";

  const tooltip = exhausted
    ? `Monthly free-tier limit reached. Resets on ${resetLabel}.`
    : `${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} row operations remaining this month. Resets on ${resetLabel}.`;

  return (
    <div
      title={tooltip}
      className={`flex items-center gap-2 border px-2.5 py-1 text-[11px] font-medium tabular-nums ${borderClass} ${textClass}`}
    >
      <span>
        {usage.consumed.toLocaleString()} / {usage.limit.toLocaleString()}
      </span>
      <span className="relative h-1 w-12 overflow-hidden bg-foreground/8">
        <span
          className={`absolute inset-y-0 left-0 transition-all duration-300 ${
            exhausted
              ? "bg-red-500/70"
              : warning
                ? "bg-amber-500/70"
                : "bg-foreground/40"
          }`}
          style={{ width: `${usage.fractionUsed * 100}%` }}
        />
      </span>
    </div>
  );
}

/**
 * "Dec 1" style label for the period-end timestamp. Uses the browser's
 * locale; the underlying period is calendar-month UTC, so the displayed
 * day will be 1 (or 31 in some timezones — acceptable rounding).
 */
function formatResetDate(periodEndsAt: number): string {
  return new Date(periodEndsAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
