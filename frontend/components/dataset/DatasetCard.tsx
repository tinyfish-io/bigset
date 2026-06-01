import Link from "next/link";
import { StatusBadge, type DatasetStatus } from "./StatusBadge";
import { MiniTable } from "./MiniTable";
import { refreshCadenceLabel, type RefreshCadence } from "@/lib/refresh-cadence";

export interface DatasetCardData {
  _id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  refreshCadence: RefreshCadence;
  columns: { name: string; type: string }[];
  // Preview is capped at 5 rows for the mini-table. The total row count
  // is on `rowCount` (denormalized counter maintained by the row write
  // mutations in convex/datasetRows.ts) so the footer stays reactive
  // past the first 5 inserts.
  previewRows: Record<string, unknown>[];
  rowCount: number;
  visibility?: "public" | "private";
}

/**
 * Single dataset card. Used in:
 *   - the dashboard's "Your Datasets" and "Curated" sections
 *   - the landing page's curated grid
 *
 * Visual treatment is intentionally identical in both places — visual
 * separation between "yours" and "curated" is done via section headers,
 * not per-card styling. That keeps the card itself simple to reason about.
 */
export function DatasetCard({ dataset }: { dataset: DatasetCardData }) {
  return (
    <Link href={`/dataset/${dataset._id}`} className="block group">
      <div className="card-glow rounded-xl">
        <div className="flex flex-col h-full rounded-xl border border-white/10 bg-surface dark:border-white/[0.06] dark:bg-surface group-hover:border-transparent">
          <div className="px-5 pt-5 pb-4">
            <h3 className="text-base font-semibold leading-tight tracking-tight">
              {dataset.name}
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted line-clamp-2">
              {dataset.description}
            </p>
          </div>

          <div className="px-4 pb-4 mt-auto">
            <MiniTable
              columns={dataset.columns}
              rows={dataset.previewRows ?? []}
            />
          </div>

          <div className="px-5 py-3 border-t border-border flex items-center justify-between">
            <div className="flex items-center gap-3">
              <StatusBadge status={dataset.status} />
              <span className="text-[11px] text-muted">
                {refreshCadenceLabel(dataset.refreshCadence)}
              </span>
            </div>
            <span className="text-[11px] text-muted">
              {dataset.rowCount ?? 0} rows
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
