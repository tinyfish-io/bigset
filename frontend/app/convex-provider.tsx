"use client";

import { ConvexReactClient } from "convex/react";
import { ConvexProvider } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { isLocalMode } from "@/lib/app-mode";

const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL || "http://127.0.0.1:3210"
);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (isLocalMode) {
    return <ConvexProvider client={convex}>{children}</ConvexProvider>;
  }

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
