"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { exchangeOpenRouterOAuth } from "@/lib/backend";
import {
  clearOpenRouterOAuthState,
  getOpenRouterOAuthReturnTo,
  OPENROUTER_VERIFIER_KEY,
} from "@/lib/openrouter-oauth";

export default function OpenRouterCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const code = searchParams.get("code");
    const verifier = sessionStorage.getItem(OPENROUTER_VERIFIER_KEY);

    if (!code || !verifier) {
      setTimeout(() => {
        setError("OpenRouter did not return the expected OAuth values.");
      }, 0);
      return;
    }

    const returnTo = getOpenRouterOAuthReturnTo();
    exchangeOpenRouterOAuth(code, verifier)
      .then(() => {
        clearOpenRouterOAuthState();
        router.replace(returnTo);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "OpenRouter OAuth failed");
      });
  }, [router]);

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-md border border-border bg-surface p-5 text-center">
        {error ? (
          <>
            <h1 className="text-sm font-semibold">OpenRouter connection failed</h1>
            <p className="mt-2 text-xs leading-5 text-muted">{error}</p>
            <button
              type="button"
              onClick={() => router.replace(getOpenRouterOAuthReturnTo())}
              className="mt-4 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-foreground/[0.04]"
            >
              Back
            </button>
          </>
        ) : (
          <div className="flex items-center justify-center gap-3 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" />
            Connecting OpenRouter...
          </div>
        )}
      </div>
    </div>
  );
}
