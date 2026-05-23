"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DatasetTable } from "@/components/table";
import { useSelection } from "@/components/table/use-selection";
import { ThemeToggle } from "@/components/ThemeToggle";
import { StatusBadge } from "@/components/dataset/StatusBadge";
import { downloadCSV, downloadXLSX } from "@/lib/export";
import { populate } from "@/lib/backend";
import { EVENTS, captureException, track } from "@/lib/analytics";

export default function DatasetPage() {
  const params = useParams();
  const { isLoading: authLoading } = useConvexAuth();
  const { userId, getToken } = useAuth();
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [populating, setPopulating] = useState(false);

  const datasetId = params.id as Id<"datasets">;
  const dataset = useQuery(
    api.datasets.get,
    authLoading ? "skip" : { id: datasetId },
  );
  const rows = useQuery(
    api.datasetRows.listByDataset,
    authLoading ? "skip" : { datasetId },
  );

  const rowIds = useMemo(() => (rows ?? []).map((r) => r._id), [rows]);
  const selection = useSelection(rowIds);
  const selectedCount = selection.selected.size;

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

    // If the user has rows selected, export ONLY those. Otherwise the
    // entire dataset. Preserves column ordering (handled by the export
    // util — it iterates `dataset.columns` in order).
    const exportRows =
      selectedCount > 0
        ? rows.filter((r) => selection.selected.has(r._id))
        : rows;
    if (exportRows.length === 0) return;

    setExporting(format);
    try {
      if (format === "csv") {
        downloadCSV(dataset.name, dataset.columns, exportRows);
      } else {
        await downloadXLSX(dataset.name, dataset.columns, exportRows);
      }
      track(EVENTS.DATASET_EXPORTED, {
        format,
        row_count: exportRows.length,
        total_rows: rows.length,
        selected_only: selectedCount > 0,
        seedKey: dataset.seedKey,
      });
    } catch (err) {
      console.error("[export] failed", err);
      captureException(err, {
        operation: "dataset_export",
        format,
        datasetId: dataset._id,
        row_count: exportRows.length,
        selected_only: selectedCount > 0,
      });
    } finally {
      setExporting(null);
    }
  }

  async function handlePopulate() {
    if (!dataset || populating) return;
    setPopulating(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      await populate(
        dataset._id,
        dataset.name,
        dataset.description,
        dataset.columns,
        token,
      );
      track(EVENTS.DATASET_POPULATED, {
        datasetId: dataset._id,
        column_count: dataset.columns.length,
      });
    } catch (err) {
      console.error("[populate] failed", err);
      captureException(err, {
        operation: "dataset_populate",
        datasetId: dataset._id,
      });
    } finally {
      setPopulating(false);
    }
  }

  if (authLoading || dataset === undefined || rows === undefined) {
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

  const exportDisabled = exporting !== null || rows.length === 0;
  const csvLabel =
    exporting === "csv"
      ? "Exporting…"
      : selectedCount > 0
        ? `Export CSV (${selectedCount})`
        : "Export CSV";
  const xlsxLabel =
    exporting === "xlsx"
      ? "Exporting…"
      : selectedCount > 0
        ? `Export XLSX (${selectedCount})`
        : "Export XLSX";

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
            disabled={exportDisabled}
            title={
              selectedCount > 0
                ? `Export ${selectedCount} selected row${selectedCount === 1 ? "" : "s"} to CSV`
                : "Export all rows to CSV"
            }
            className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {csvLabel}
          </button>
          <button
            onClick={() => handleExport("xlsx")}
            disabled={exportDisabled}
            title={
              selectedCount > 0
                ? `Export ${selectedCount} selected row${selectedCount === 1 ? "" : "s"} to XLSX`
                : "Export all rows to XLSX"
            }
            className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {xlsxLabel}
          </button>
          <button
            onClick={handlePopulate}
            disabled={populating}
            className="border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {populating ? "Populating…" : "Clear & Populate"}
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
          {selectedCount > 0 && (
            <>
              <span className="text-foreground/80 font-medium">
                {selectedCount} selected
              </span>
              <span className="text-foreground/10">|</span>
            </>
          )}
          <span>{rows.length} rows</span>
          <span className="text-foreground/10">|</span>
          <span>{dataset.columns.length} columns</span>
        </div>
      </div>

      <DatasetTable
        dataset={dataset}
        rows={rows}
        datasetId={datasetId}
        selection={selection}
      />
    </div>
  );
}
