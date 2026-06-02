export type RefreshCadence = "manual" | "30m" | "6h" | "12h" | "daily" | "weekly";

export const REFRESH_CADENCE_OPTIONS: { value: RefreshCadence; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "30m", label: "Every 30 min" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export const REFRESH_CADENCE_LABELS = Object.fromEntries(
  REFRESH_CADENCE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<RefreshCadence, string>;

export function refreshCadenceLabel(cadence: RefreshCadence): string {
  return REFRESH_CADENCE_LABELS[cadence];
}
