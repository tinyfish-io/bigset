"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { useUser, useClerk } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import {
  DatasetCard,
  type DatasetCardData,
} from "@/components/dataset/DatasetCard";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EVENTS, track } from "@/lib/analytics";

export default function DashboardPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [search, setSearch] = useState("");

  const mine = useQuery(
    api.datasets.listMine,
    isAuthenticated ? {} : "skip",
  );
  // Public datasets are open to anonymous users too, so no `skip` gate.
  const curated = useQuery(api.datasets.listPublic, {});

  const seedData = useMutation(api.seed.seed);
  const hasSeeded = useRef(false);

  useEffect(() => {
    if (mine && mine.length === 0 && isAuthenticated && !hasSeeded.current) {
      hasSeeded.current = true;
      seedData({});
    }
  }, [mine, isAuthenticated, seedData]);

  // Fire dashboard_viewed once per mount when both queries have resolved,
  // so we attach accurate counts. `dashboardFired` prevents the effect
  // from re-firing when filtered counts change due to typing in search.
  const dashboardFired = useRef(false);
  useEffect(() => {
    if (
      !dashboardFired.current &&
      isAuthenticated &&
      mine !== undefined &&
      curated !== undefined
    ) {
      dashboardFired.current = true;
      track(EVENTS.DASHBOARD_VIEWED, {
        owned_count: mine.length,
        curated_count: curated.length,
      });
    }
  }, [isAuthenticated, mine, curated]);

  const { filteredMine, filteredCurated } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const apply = (list: typeof mine) =>
      (list ?? []).filter((ds) =>
        !q ||
        ds.name.toLowerCase().includes(q) ||
        ds.description.toLowerCase().includes(q),
      );
    return {
      filteredMine: apply(mine),
      filteredCurated: apply(curated),
    };
  }, [mine, curated, search]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-surface">
        <img src="/BigSetLogo.png" alt="BigSet" className="h-[30px]" />
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <div className="w-px h-4 bg-border" />
          {/* PII: mask the email in session replays */}
          <span data-ph-mask-text="true" className="text-xs text-muted">
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

      <main className="flex-1 px-6 py-10 max-w-[1280px] mx-auto w-full">
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
              aria-hidden="true"
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
              onBlur={() => {
                // Fire on blur, not every keystroke. Send length, not the
                // query string itself — search terms can be sensitive
                // ("looking for a job at X"). Length is enough for the funnel.
                if (search.trim().length > 0) {
                  track(EVENTS.DATASET_SEARCH_USED, {
                    query_length: search.trim().length,
                    mine_count: filteredMine.length,
                    curated_count: filteredCurated.length,
                  });
                }
              }}
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

        <Section
          eyebrow="Yours"
          heading="Datasets you own"
          isLoading={mine === undefined}
          datasets={filteredMine as unknown as DatasetCardData[]}
          emptyState={
            search
              ? `No datasets of yours match "${search}".`
              : "You don't have any datasets yet. Create your first one above."
          }
        />

        <div className="h-12" />

        <Section
          eyebrow="Curated by BigSet"
          heading="Explore live datasets"
          isLoading={curated === undefined}
          datasets={filteredCurated as unknown as DatasetCardData[]}
          emptyState={
            search
              ? `No curated datasets match "${search}".`
              : "Curated datasets coming soon."
          }
        />
      </main>
    </div>
  );
}

function Section({
  eyebrow,
  heading,
  isLoading,
  datasets,
  emptyState,
}: {
  eyebrow: string;
  heading: string;
  isLoading: boolean;
  datasets: DatasetCardData[];
  emptyState: string;
}) {
  return (
    <div>
      <div className="mb-5">
        <p className="text-[11px] uppercase tracking-[0.15em] text-muted font-semibold">
          {eyebrow}
        </p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight">
          {heading}
        </h3>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted">Loading…</p>
        </div>
      ) : datasets.length === 0 ? (
        <div className="border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted">{emptyState}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {datasets.map((ds) => (
            <DatasetCard key={ds._id} dataset={ds} />
          ))}
        </div>
      )}
    </div>
  );
}
