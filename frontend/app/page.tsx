"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { useEffect } from "react";

export default function Home() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, router]);

  if (isLoading || isAuthenticated) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <img src="/BigSetLogo.png" alt="BigSet" className="h-12 mx-auto" />
          <p className="mt-3 text-lg text-muted">
            Live, queryable datasets — updated automatically.
          </p>
        </div>

        <div className="flex justify-center">
          <Link
            href="/sign-in"
            className="border border-accent bg-accent px-6 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </div>
      </div>
    </div>
  );
}
