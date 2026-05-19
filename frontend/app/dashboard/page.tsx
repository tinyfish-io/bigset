"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { useUser, useClerk } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";

type DatasetStatus = "live" | "paused" | "building";

function StatusBadge({ status }: { status: DatasetStatus }) {
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

function MiniTable({
  columns,
  rows,
}: {
  columns: { name: string }[];
  rows: Record<string, string>[];
}) {
  const previewCols = columns.slice(0, 5);

  return (
    <div className="overflow-hidden border border-border bg-surface">
      <table className="w-full text-[10px] leading-none">
        <thead>
          <tr className="border-b border-border bg-background">
            {previewCols.map((col, i) => (
              <th
                key={i}
                className="px-2 py-1.5 text-left font-semibold text-foreground/60 whitespace-nowrap uppercase tracking-wider"
                style={{ fontSize: "9px" }}
              >
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              {previewCols.map((col, j) => {
                const raw = row[col.name];
                const val = raw == null ? "" : String(raw);
                return (
                  <td
                    key={j}
                    className={`px-2 py-1.5 whitespace-nowrap ${j === 0 ? "text-foreground/80 font-medium" : "text-muted"}`}
                  >
                    {val.length > 20 ? val.slice(0, 20) + "..." : val}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function DatasetCard({ dataset }: { dataset: any }) {
  return (
    <Link href={`/dataset/${dataset._id}`} className="block">
      <div className="group flex flex-col border border-border bg-surface transition-all hover:border-foreground/20 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] cursor-pointer">
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
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function DashboardPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [search, setSearch] = useState("");

  const datasets = useQuery(
    api.datasets.listWithPreview,
    isAuthenticated ? {} : "skip"
  );

  const seedData = useMutation(api.seed.seed);
  const hasSeeded = useRef(false);

  useEffect(() => {
    if (datasets && datasets.length === 0 && isAuthenticated && !hasSeeded.current) {
      hasSeeded.current = true;
      seedData({});
    }
  }, [datasets, isAuthenticated, seedData]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const filtered = (datasets ?? []).filter(
    (ds) =>
      ds.name.toLowerCase().includes(search.toLowerCase()) ||
      ds.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-surface">
        <img src="/BigSetLogo.png" alt="BigSet" className="h-[30px]" />
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted">
            {user?.primaryEmailAddress?.emailAddress}
          </span>
          <div className="w-px h-4 bg-border" />
          <button
            onClick={() => signOut()}
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 px-6 py-10 max-w-[1200px] mx-auto w-full">
        <div className="mb-8">
          <h2 className="text-[28px] font-bold tracking-tight leading-none">
            Your Datasets
          </h2>
          <p className="mt-2 text-sm text-muted">
            Live, updating datasets — powered by web agents.
          </p>
        </div>

        <div className="flex items-center gap-3 mb-8">
          <div className="relative flex-1 max-w-md">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
              />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search datasets..."
              className="w-full border border-border bg-surface py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-muted/60 focus:border-foreground/30 transition-colors"
            />
          </div>
          <Link
            href="/dataset/new"
            className="border border-accent bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
          >
            + New Dataset
          </Link>
        </div>

        {datasets === undefined ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-sm text-muted">Loading datasets...</p>
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((ds) => (
              <DatasetCard key={ds._id} dataset={ds} />
            ))}
          </div>
        ) : search ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-sm text-muted">
              No datasets match &ldquo;{search}&rdquo;
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-sm text-muted">
              No datasets yet. Create your first one.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
