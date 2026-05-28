export type DatasetStatus = "live" | "paused" | "building" | "failed";

const STYLES: Record<DatasetStatus, string> = {
  live: "border-emerald-600/20 bg-emerald-600/5 text-emerald-700 dark:text-emerald-400",
  paused: "border-border bg-background text-muted",
  building: "border-amber-600/20 bg-amber-600/5 text-amber-700 dark:text-amber-400",
  failed: "border-red-600/20 bg-red-600/5 text-red-700 dark:text-red-400",
};

const LABELS: Record<DatasetStatus, string> = {
  live: "Live",
  paused: "Paused",
  building: "Building...",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: DatasetStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STYLES[status]}`}
    >
      {status === "live" && (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-pulse" />
      )}
      {status === "building" && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-600 animate-pulse" />
      )}
      {status === "failed" && (
        <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
      )}
      {LABELS[status]}
    </span>
  );
}
