"use client";

import Link from "next/link";
import { redirect } from "next/navigation";
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DatasetCard, type DatasetCardData } from "@/components/dataset/DatasetCard";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EVENTS, track } from "@/lib/analytics";
import { useAppConvexAuth } from "@/lib/app-auth";

const PUBLIC_GRID_COUNT = 9;

export default function Home() {
  const { isAuthenticated, isLoading } = useAppConvexAuth();
  const publicDatasets = useQuery(api.datasets.listPublic, {}) as DatasetCardData[] | undefined;

  // Fire once when the landing page actually displays to an anonymous
  // visitor. Skip if we'll immediately redirect them to the dashboard.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      track(EVENTS.LANDING_PAGE_VIEWED);
    }
  }, [isLoading, isAuthenticated]);

  if (isAuthenticated) {
    redirect("/dashboard");
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  const shownDatasets = (publicDatasets ?? []).slice(0, PUBLIC_GRID_COUNT);

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-surface">
        <img src="/BigSetLogo.png" alt="BigSet" className="h-[30px] dark:hidden" />
        <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-[30px] hidden dark:block" />
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link
            href="/sign-in"
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <section className="px-6 pt-20 pb-16">
          <div className="max-w-2xl mx-auto text-center space-y-7">
            <img src="/BigSetLogo.png" alt="BigSet" className="h-12 mx-auto dark:hidden" />
            <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-12 mx-auto hidden dark:block" />
            <p className="text-xl leading-relaxed text-foreground/80">
              Live, queryable datasets — described in plain English, kept fresh by web agents.
            </p>
            <div className="flex justify-center">
              <Link
                href="/sign-in"
                onClick={() => track(EVENTS.GET_STARTED_CLICKED)}
                className="border border-accent bg-accent px-6 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
              >
                Get started
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-14 bg-surface/40">
          <div className="max-w-[1280px] mx-auto">
            <div className="mb-10 flex items-end justify-between gap-6 flex-wrap">
              <div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-muted font-semibold">
                  Curated by BigSet
                </p>
                <h2 className="mt-2 text-[26px] font-bold tracking-tight leading-none">
                  Explore live datasets
                </h2>
                <p className="mt-3 text-sm text-muted max-w-lg">
                  Nine datasets we maintain ourselves — refreshed automatically, queryable now.
                </p>
              </div>
            </div>

            {publicDatasets === undefined ? (
              <SkeletonGrid count={PUBLIC_GRID_COUNT} />
            ) : shownDatasets.length === 0 ? (
              <div className="flex items-center justify-center py-20 border border-dashed border-border">
                <p className="text-sm text-muted">
                  Curated datasets coming soon.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {shownDatasets.map((ds) => (
                  <DatasetCard
                    key={ds._id}
                    dataset={ds}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-[280px] border border-border bg-surface animate-pulse"
        />
      ))}
    </div>
  );
}
