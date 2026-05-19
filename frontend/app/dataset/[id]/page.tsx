"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DatasetTable } from "@/components/table";

function StatusBadge({
  status,
}: {
  status: "live" | "paused" | "building";
}) {
  const styles = {
    live: "border-emerald-600/20 bg-emerald-600/5 text-emerald-700",
    paused: "border-border bg-background text-muted",
    building: "border-amber-600/20 bg-amber-600/5 text-amber-700",
  };
  const labels = { live: "Live", paused: "Paused", building: "Building..." };

  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles[status]}`}
    >
      {status === "live" && (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-pulse" />
      )}
      {status === "building" && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-600 animate-pulse" />
      )}
      {labels[status]}
    </span>
  );
}

export default function DatasetPage() {
  const params = useParams();
  const { isLoading } = useConvexAuth();

  const datasetId = params.id as Id<"datasets">;
  const dataset = useQuery(api.datasets.get, { id: datasetId });
  const rows = useQuery(api.datasetRows.listByDataset, {
    datasetId,
  });

  if (isLoading || dataset === undefined || rows === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted">Dataset not found.</p>
          <Link
            href="/dashboard"
            className="mt-4 inline-block text-sm font-semibold text-foreground hover:underline"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col h-screen">
      <header className="border-b border-border px-5 py-3 flex items-center justify-between bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="hover:opacity-80 transition-opacity">
            <img src="/BigSetLogo.png" alt="BigSet" className="h-[26px]" />
          </Link>
          <span className="text-foreground/15">/</span>
          <h1 className="text-sm font-semibold tracking-tight truncate max-w-md">
            {dataset.name}
          </h1>
          <StatusBadge status={dataset.status} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted mr-2">
            {dataset.cadence}
          </span>
          <button className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors">
            Export CSV
          </button>
          <button className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors">
            Export XLSX
          </button>
        </div>
      </header>

      <div className="border-b border-border px-5 py-2.5 flex items-center gap-4 bg-surface/50 shrink-0">
        <p className="text-xs text-muted truncate max-w-2xl">
          {dataset.description}
        </p>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-muted shrink-0">
          <span>{rows.length} rows</span>
          <span className="text-foreground/10">|</span>
          <span>{dataset.columns.length} columns</span>
        </div>
      </div>

      <DatasetTable
        dataset={dataset}
        rows={rows}
        datasetId={datasetId}
      />
    </div>
  );
}
