"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Last-resort error boundary. Renders ONLY when the error is so deep
 * that even the root `app/layout.tsx` couldn't render — e.g. a
 * provider itself threw during render.
 *
 * Because the layout is bypassed, Clerk / Convex / AnalyticsProvider are
 * NOT mounted here. We can't use the analytics module's helpers (they
 * check `initialized` which depends on AnalyticsProvider running). We
 * call posthog directly inside a try/catch and accept that the report
 * may not always land.
 *
 * Must define its own <html> and <body>. Must be a client component.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      posthog.captureException(error, {
        source: "react.global_error_boundary",
        digest: error.digest,
        pathname:
          typeof window !== "undefined" ? window.location.pathname : "?",
      });
    } catch {
      // PostHog itself may not be initialized at this point. Nothing
      // useful we can do — fall through to the fallback UI.
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#141210",
          color: "#e8e4de",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 24px",
        }}
      >
        <div style={{ maxWidth: 360, textAlign: "center" }}>
          <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            BigSet hit an unexpected error.
          </p>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            The error has been reported. Please reload the page.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              fontSize: 12,
              fontWeight: 600,
              background: "#e8e4de",
              color: "#141210",
              border: "1px solid #e8e4de",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
