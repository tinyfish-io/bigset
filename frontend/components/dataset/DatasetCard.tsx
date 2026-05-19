import Link from "next/link";
import { StatusBadge, type DatasetStatus } from "./StatusBadge";
import { MiniTable } from "./MiniTable";

export interface DatasetCardData {
  _id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  cadence: string;
  columns: { name: string; type: string }[];
  previewRows: Record<string, unknown>[];
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
      <div className="flex flex-col h-full border border-border bg-surface transition-all duration-150 group-hover:border-foreground/20 group-hover:shadow-[0_2px_12px_rgba(0,0,0,0.05)] dark:group-hover:shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
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
            <span className="text-[11px] text-muted">{dataset.cadence}</span>
          </div>
          <span className="text-[11px] text-muted">
            {dataset.previewRows?.length ?? 0} rows
          </span>
        </div>
      </div>
    </Link>
  );
}
