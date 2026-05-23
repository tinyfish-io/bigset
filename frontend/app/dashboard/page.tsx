"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useConvexAuth } from "convex/react";
import { useUser, useClerk } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import {
  DatasetCard,
  type DatasetCardData,
} from "@/components/dataset/DatasetCard";
import { ThemeToggle } from "@/components/ThemeToggle";
import { QuotaBadge } from "@/components/QuotaBadge";
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

  // Quota state drives the "+ New Dataset" button — disabled when the
  // user is at their free-tier limit. `undefined` while loading.
  const usage = useQuery(
    api.quota.getMy,
    isAuthenticated ? {} : "skip",
  );
  const atLimit = usage !== undefined && usage.remaining === 0;

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
        <img src="/BigSetLogo.png" alt="BigSet" className="h-[30px] dark:hidden" />
        <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-[30px] hidden dark:block" />
        <div className="flex items-center gap-4">
          <QuotaBadge />
          <div className="w-px h-4 bg-border" />
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
              className="w-full rounded-lg border border-border bg-surface py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-muted/60 focus:border-foreground/30 transition-[border-color] duration-150"
            />
          </div>
          {atLimit ? (
            <div className="relative group">
              <span
                role="button"
                tabIndex={0}
                aria-disabled="true"
                aria-describedby="quota-popover"
                className="inline-block rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-muted cursor-not-allowed select-none focus:outline-none focus:ring-1 focus:ring-foreground/20"
              >
                + New Dataset
              </span>
              {/*
                Custom popover beside the disabled button. Replaces the
                native `title=""` tooltip so we can style consistently
                with the rest of the UI and use the exact wording requested.
                Shown on hover via Tailwind's `group-hover`.
              */}
              <div
                id="quota-popover"
                role="tooltip"
                className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-20 w-64 rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground opacity-0 translate-x-[-4px] transition-all duration-150 ease-out shadow-[0_4px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.4)] group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0"
              >
                <span className="absolute -left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 rotate-45 border-l border-b border-border bg-surface" />
                Free-tier limit reached (2,500 row modifications). Please upgrade.
              </div>
            </div>
          ) : (
            <Link
              href="/dataset/new"
              className="rounded-lg border border-accent bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
            >
              + New Dataset
            </Link>
          )}
        </div>

        <Section
          eyebrow="Yours"
          heading="Datasets you own"
          isLoading={mine === undefined}
          datasets={filteredMine as unknown as DatasetCardData[]}
          emptyState={
            search
              ? `No datasets of yours match "${search}".`
              : atLimit
                ? "You've used all of this month's free-tier quota. New datasets will be available again when the quota resets at the start of next month."
                : "No datasets yet. Click \"+ New Dataset\" above to create your first one."
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
