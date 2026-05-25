"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useConvexAuth } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DatasetTable } from "@/components/table";
import { useSelection } from "@/components/table/use-selection";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  StatusBadge,
  type DatasetStatus,
} from "@/components/dataset/StatusBadge";
import { downloadCSV, downloadXLSX } from "@/lib/export";
import {
  PopulateApiError,
  populate,
  type PopulateRunSummary,
} from "@/lib/backend";
import { EVENTS, captureException, track } from "@/lib/analytics";

type PopulateStatus =
  | { state: "idle" }
  | { state: "running"; startedAt: number }
  | { state: "accepted"; summary: PopulateRunSummary }
  | { state: "rejected"; message: string; summary?: PopulateRunSummary }
  | { state: "failed"; message: string; summary?: PopulateRunSummary };

export default function DatasetPage() {
  const params = useParams();
  const { isLoading: authLoading } = useConvexAuth();
  const { userId, getToken } = useAuth();
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [populating, setPopulating] = useState(false);
  const [populateStatus, setPopulateStatus] = useState<PopulateStatus>({
    state: "idle",
  });
  const [clockNow, setClockNow] = useState(() => Date.now());

  const datasetId = params.id as Id<"datasets">;
  const dataset = useQuery(
    api.datasets.get,
    authLoading ? "skip" : { id: datasetId },
  );
  const rows = useQuery(
    api.datasetRows.listByDataset,
    authLoading ? "skip" : { datasetId },
  );
  const updateDatasetStatus = useMutation(api.datasets.updateStatus);

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

  useEffect(() => {
    if (populateStatus.state !== "running") {
      return;
    }
    const intervalId = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [populateStatus.state]);

  async function setDatasetStatusSafely(status: "live" | "paused") {
    if (!dataset) return;
    try {
      await updateDatasetStatus({ id: dataset._id, status });
    } catch (err) {
      console.warn("[populate] failed to update dataset status", err);
    }
  }

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
    const startedAt = Date.now();
    setClockNow(startedAt);
    setPopulating(true);
    setPopulateStatus({ state: "running", startedAt });
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      const response = await populate(
        dataset._id,
        dataset.name,
        dataset.description,
        dataset.columns,
        token,
      );
      setPopulateStatus({ state: "accepted", summary: response.result });
      await setDatasetStatusSafely(
        (response.result.committedRows?.insertedRowCount ?? 0) > 0
          ? "live"
          : "paused",
      );
      track(EVENTS.DATASET_POPULATED, {
        datasetId: dataset._id,
        column_count: dataset.columns.length,
        committed_row_count: response.result.committedRows?.insertedRowCount ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to populate dataset.";
      const summary = err instanceof PopulateApiError ? err.result : undefined;
      if (err instanceof PopulateApiError && summary?.success === false) {
        console.warn("[populate] rejected", {
          status: err.status,
          action: summary.action,
          validationState: summary.validationState,
          validationIssues: summary.validationIssues,
          rejectionReasons: summary.rejectionReasons,
        });
        setPopulateStatus({
          state: "rejected",
          message,
          summary,
        });
        await setDatasetStatusSafely("paused");
        return;
      }

      console.error("[populate] failed", err);
      setPopulateStatus({
        state: "failed",
        message,
        summary,
      });
      await setDatasetStatusSafely("paused");
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
  const trustSummary = trustSummaryForRows(rows);
  const elapsedSeconds = populateStatus.state === "running"
    ? Math.max(0, Math.floor((Math.max(clockNow, populateStatus.startedAt) - populateStatus.startedAt) / 1_000))
    : 0;
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
  const displayStatus = statusForCurrentPopulateState({
    storedStatus: dataset.status,
    isPopulateRequestOpen: populateStatus.state === "running",
    rowCount: rows.length,
  });

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
          <StatusBadge status={displayStatus} />
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

      <PopulateTrustStrip
        populateStatus={populateStatus}
        trustSummary={trustSummary}
        elapsedSeconds={elapsedSeconds}
      />

      <DatasetTable
        dataset={dataset}
        rows={rows}
        datasetId={datasetId}
        selection={selection}
      />
    </div>
  );
}

function statusForCurrentPopulateState({
  storedStatus,
  isPopulateRequestOpen,
  rowCount,
}: {
  storedStatus: DatasetStatus;
  isPopulateRequestOpen: boolean;
  rowCount: number;
}): DatasetStatus {
  if (isPopulateRequestOpen) {
    return "building";
  }
  if (storedStatus === "building") {
    return rowCount > 0 ? "live" : "paused";
  }
  return storedStatus;
}

function trustSummaryForRows(rows: NonNullable<ReturnType<typeof useQuery>>[]) {
  const sourceUrls = uniqueStrings(
    rows.flatMap((row) => Array.isArray(row.sources) ? row.sources : []),
  );
  const evidence = rows
    .flatMap((row) => Array.isArray(row.evidence) ? row.evidence : [])
    .filter((item) =>
      typeof item?.sourceUrl === "string" &&
      typeof item?.quote === "string" &&
      item.sourceUrl &&
      item.quote
    );
  return {
    sourceUrls,
    evidence,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function PopulateTrustStrip({
  populateStatus,
  trustSummary,
  elapsedSeconds,
}: {
  populateStatus: PopulateStatus;
  trustSummary: {
    sourceUrls: string[];
    evidence: Array<{
      columnName?: string;
      sourceUrl: string;
      quote: string;
    }>;
  };
  elapsedSeconds: number;
}) {
  const summary = "summary" in populateStatus
    ? populateStatus.summary
    : undefined;
  const statusTone =
    populateStatus.state === "accepted"
      ? summary?.productionValidation?.state === "accepted_partial"
        ? "text-amber-700 border-amber-600/20 bg-amber-600/[0.04]"
        : "text-emerald-700 border-emerald-600/20 bg-emerald-600/[0.04]"
      : populateStatus.state === "rejected" || populateStatus.state === "failed"
        ? "text-red-700 border-red-600/20 bg-red-600/[0.04]"
        : "text-muted border-border bg-surface";
  const firstEvidence = trustSummary.evidence[0] ?? summary?.sampleRows
    .flatMap((row) => row.evidence)[0];
  const sourceUrls = trustSummary.sourceUrls.length > 0
    ? trustSummary.sourceUrls
    : uniqueStrings(summary?.sampleRows.flatMap((row) => row.sourceUrls) ?? []);

  if (
    populateStatus.state === "idle" &&
    sourceUrls.length === 0 &&
    !firstEvidence
  ) {
    return null;
  }

  return (
    <section className="border-b border-border px-5 py-2.5 bg-background shrink-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <span className={`border px-2 py-1 font-medium ${statusTone}`}>
          {populateStatusLabel(populateStatus, summary)}
        </span>
        {populateStatus.state === "running" && (
          <span className="text-muted">
            waiting for backend response · {elapsedSeconds}s elapsed
          </span>
        )}
        {summary?.productionValidation && (
          <span className="text-muted">
            validation {validationStateLabel(summary.productionValidation.state)}
            {" · "}
            score {summary.productionValidation.score.toFixed(2)}
          </span>
        )}
        {summary?.validationIssues?.[0] && (
          <span className="max-w-xl truncate text-muted" title={summary.validationIssues.join("\n")}>
            {summary.validationIssues[0]}
          </span>
        )}
        {summary?.rejectionReasons?.[0] && (
          <span className="max-w-xl truncate text-red-700" title={summary.rejectionReasons.join("\n")}>
            {summary.rejectionReasons[0]}
          </span>
        )}
        {sourceUrls.slice(0, 3).map((sourceUrl) => (
          <a
            key={sourceUrl}
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-[220px] truncate text-blue-600 underline underline-offset-2 decoration-blue-600/30"
          >
            {sourceUrl}
          </a>
        ))}
        {firstEvidence && (
          <span
            className="max-w-xl truncate text-foreground/70"
            title={`${firstEvidence.sourceUrl}\n${firstEvidence.quote}`}
          >
            evidence: {firstEvidence.quote}
          </span>
        )}
      </div>
    </section>
  );
}

function populateStatusLabel(
  populateStatus: PopulateStatus,
  summary?: PopulateRunSummary,
): string {
  if (populateStatus.state === "running") {
    return "Populate request open";
  }
  if (populateStatus.state === "accepted") {
    const rowCount = summary?.committedRows?.insertedRowCount ??
      summary?.rowCount ??
      0;
    if (summary?.productionValidation?.state === "accepted_partial") {
      return `Accepted partial ${rowCount} rows`;
    }
    return `Accepted full ${rowCount} rows`;
  }
  if (populateStatus.state === "rejected") {
    return "Rejected: no rows written";
  }
  if (populateStatus.state === "failed") {
    return populateStatus.message;
  }
  return "Populate evidence";
}

function validationStateLabel(
  state: NonNullable<PopulateRunSummary["productionValidation"]>["state"],
): string {
  if (state === "accepted_full") {
    return "accepted full";
  }
  if (state === "accepted_partial") {
    return "accepted partial";
  }
  return "rejected";
}
