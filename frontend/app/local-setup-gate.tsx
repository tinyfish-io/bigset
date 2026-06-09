"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { getLocalSetupStatus, type LocalSetupStatus } from "@/lib/backend";
import { isLocalMode } from "@/lib/app-mode";

function isSetupPath(pathname: string): boolean {
  return pathname === "/setup" || pathname.startsWith("/setup/");
}

export function LocalSetupGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [statusState, setStatusState] = useState<{
    pathname: string;
    status: LocalSetupStatus;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isLocalMode) return;
    if (isSetupPath(pathname)) return;
    let cancelled = false;
    getLocalSetupStatus()
      .then((next) => {
        if (!cancelled) {
          setFailed(false);
          setStatusState({ pathname, status: next });
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const status =
    statusState?.pathname === pathname ? statusState.status : null;

  useEffect(() => {
    if (!isLocalMode || !status || status.complete || isSetupPath(pathname)) {
      return;
    }
    router.replace("/setup");
  }, [pathname, router, status]);

  if (!isLocalMode || isSetupPath(pathname)) return <>{children}</>;

  if (failed) return <>{children}</>;

  if (!status || !status.complete) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">Loading...</p>
      </div>
    );
  }

  return <>{children}</>;
}
