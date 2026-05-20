"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DatasetTable } from "@/components/table";
import { ThemeToggle } from "@/components/ThemeToggle";
import { StatusBadge } from "@/components/dataset/StatusBadge";
import { downloadCSV, downloadXLSX } from "@/lib/export";
import { EVENTS, captureException, track } from "@/lib/analytics";

export default function DatasetPage() {
  const params = useParams();
  const { isLoading } = useConvexAuth();
  const { userId } = useAuth();
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);

  const datasetId = params.id as Id<"datasets">;
  const dataset = useQuery(api.datasets.get, { id: datasetId });
  const rows = useQuery(api.datasetRows.listByDataset, {
    datasetId,
  });

  // Fire dataset_opened once per dataset visit, after the dataset has
  // resolved. The ref keeps it idempotent across re-renders.
  const openedFired = useRef<string | null>(null);
  useEffect(() => {
    if (dataset && openedFired.current !== dataset._id) {
      openedFired.current = dataset._id;
      track(EVENTS.DATASET_OPENED, {
        datasetId: dataset._id,
        seedKey: dataset.seedKey,
        visibility: dataset.visibility ?? "private",
        is_owner: userId === dataset.ownerId,
      });
    }
  }, [dataset, userId]);

  async function handleExport(format: "csv" | "xlsx") {
    if (!dataset || !rows || exporting) return;
    setExporting(format);
    try {
      if (format === "csv") {
        downloadCSV(dataset.name, dataset.columns, rows);
      } else {
        await downloadXLSX(dataset.name, dataset.columns, rows);
      }
      track(EVENTS.DATASET_EXPORTED, {
        format,
        row_count: rows.length,
        seedKey: dataset.seedKey,
      });
    } catch (err) {
      console.error("[export] failed", err);
      captureException(err, {
        operation: "dataset_export",
        format,
        datasetId: dataset._id,
        row_count: rows.length,
      });
    } finally {
      setExporting(null);
    }
  }

  if (isLoading || dataset === undefined || rows === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }
  // Past this point `dataset` and `rows` are always defined. If the
  // server-side authz layer rejected the request, `useQuery` would have
  // thrown instead — caught by /dataset/[id]/error.tsx, which renders
  // the "Dataset not found" UI.

  return (
    <div className="flex flex-1 flex-col h-screen">
      <header className="border-b border-border px-5 py-3 flex items-center justify-between bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="hover:opacity-80 transition-opacity">
            <img src="/BigSetLogo.png" alt="BigSet" className="h-[26px] dark:hidden" />
            <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-[26px] hidden dark:block" />
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
          <button
            onClick={() => handleExport("csv")}
            disabled={exporting !== null || rows.length === 0}
            className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {exporting === "csv" ? "Exporting…" : "Export CSV"}
          </button>
          <button
            onClick={() => handleExport("xlsx")}
            disabled={exporting !== null || rows.length === 0}
            className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {exporting === "xlsx" ? "Exporting…" : "Export XLSX"}
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <ThemeToggle />
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
