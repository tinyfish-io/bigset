export type RefreshCadence = "manual" | "30m" | "6h" | "12h" | "daily" | "weekly";

export const REFRESH_CADENCE_OPTIONS: { value: RefreshCadence; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "30m", label: "Every 30 min" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export const REFRESH_CADENCE_LABELS: Record<RefreshCadence, string> = {
  manual: "Manual",
  "30m": "Every 30 min",
  "6h": "Every 6 hours",
  "12h": "Every 12 hours",
  daily: "Daily",
  weekly: "Weekly",
};

export function refreshCadenceLabel(cadence: RefreshCadence): string {
  return REFRESH_CADENCE_LABELS[cadence];
}
