import { v } from "convex/values";

export const refreshCadenceValidator = v.union(
  v.literal("manual"),
  v.literal("30m"),
  v.literal("6h"),
  v.literal("12h"),
  v.literal("daily"),
  v.literal("weekly"),
);

export type RefreshCadence = "manual" | "30m" | "6h" | "12h" | "daily" | "weekly";

export const REFRESH_INTERVAL_MS: Record<Exclude<RefreshCadence, "manual">, number> = {
  "30m": 30 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function nextRefreshAtFor(
  cadence: RefreshCadence,
  from: number,
): number | undefined {
  if (cadence === "manual") return undefined;
  return from + REFRESH_INTERVAL_MS[cadence];
}
