/**
 * Analytics & error tracking — thin wrapper around posthog-js.
 *
 * Why this exists, not raw `posthog.capture()` calls in components:
 *   - One init point, one place to change config
 *   - Event names are constants — renames are a one-line refactor
 *   - Graceful no-op when `NEXT_PUBLIC_POSTHOG_KEY` is unset
 *   - SSR-safe: every public call short-circuits if there's no window
 *
 * Identity bridging with Clerk lives in `analytics-provider.tsx`.
 *
 * Session replay & autocapture are NOT disabled here — they're controlled
 * by the PostHog project dashboard. This file configures the SAFETY rules
 * (text masking, input masking, no cross-origin frames) that apply whenever
 * recording is on.
 */

import posthog from "posthog-js";

// Single source of truth for event names. Past-tense snake_case.
export const EVENTS = {
  // Auth / onboarding
  LANDING_PAGE_VIEWED: "landing_page_viewed",
  GET_STARTED_CLICKED: "get_started_clicked",
  SIGN_IN_VIEWED: "sign_in_viewed",
  SIGN_UP_VIEWED: "sign_up_viewed",

  // Dashboard
  DASHBOARD_VIEWED: "dashboard_viewed",
  DATASET_SEARCH_USED: "dataset_search_used",

  // Dataset interaction
  DATASET_OPENED: "dataset_opened",
  DATASET_EXPORTED: "dataset_exported",
  DATASET_POPULATED: "dataset_populated",

  // Creation flow
  DATASET_CREATION_STARTED: "dataset_creation_started",
  DATASET_SCHEMA_GENERATED: "dataset_schema_generated",
  DATASET_CREATED: "dataset_created",

  // App-level
  THEME_CHANGED: "theme_changed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

let initialized = false;
let errorListenersAttached = false;

/**
 * Initialize PostHog. Safe to call multiple times — only the first call
 * does anything.
 */
export function initAnalytics(): boolean {
  if (initialized) return true;
  if (typeof window === "undefined") return false;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return false;

  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

  posthog.init(key, {
    api_host: host,

    // We fire named page-view events ourselves — no implicit $pageview.
    capture_pageview: false,
    capture_pageleave: false,

    // Autocapture + session_recording are intentionally NOT overridden
    // here. Their on/off state lives in the PostHog project dashboard.
    // This file controls the SAFETY behavior that applies whenever
    // recording is on (see session_recording block below).
    disable_surveys: true,

    persistence: "localStorage+cookie",

    // Session replay safety
    //   - maskTextSelector: text inside any element with
    //     data-ph-mask-text is replaced with `*`s in replays. Used on
    //     dataset table cells and the dashboard email.
    //   - maskInputOptions: every form input/textarea value is masked
    //     unconditionally. Catches the search box, the wizard prompt,
    //     Clerk's email + password fields.
    //   - recordConsole: console.error/warn shows up alongside the
    //     replay timeline — invaluable for "user says it broke".
    //   - recordCrossOriginIframes: false → Clerk's hosted iframes
    //     (if any) are not pierced into.
    session_recording: {
      maskTextSelector: "[data-ph-mask-text]",
      maskInputOptions: {
        text: true,
        textarea: true,
        password: true,
        email: true,
      },
      recordCrossOriginIframes: false,
      recordConsole: true,
    },

    loaded: () => {
      if (process.env.NODE_ENV === "development") {
        // eslint-disable-next-line no-console
        console.info("[analytics] posthog initialized");
      }
    },
  });

  initialized = true;
  attachGlobalErrorListeners();
  return true;
}

/**
 * Attach window-level error listeners exactly once. Captures errors
 * that escape React's tree — async handler throws, promise rejections,
 * stray bugs in third-party scripts. React rendering crashes are caught
 * separately by app/error.tsx and app/global-error.tsx.
 */
function attachGlobalErrorListeners(): void {
  if (errorListenersAttached) return;
  if (typeof window === "undefined") return;

  window.addEventListener("error", (event) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message);
    captureException(err, {
      source: "window.error",
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const err =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "Unhandled promise rejection");
    captureException(err, { source: "unhandledrejection" });
  });

  errorListenersAttached = true;
}

/**
 * Fire a tracked product event. No-ops if PostHog isn't initialized.
 */
export function track(
  name: EventName,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!initialized) {
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.debug("[analytics] (no-op)", name, properties ?? {});
    }
    return;
  }
  posthog.capture(name, properties);
}

/**
 * Report a JavaScript error to PostHog's Errors product.
 *
 * Use in catch blocks where the error doesn't propagate to a React
 * boundary (async work, event handlers). Adds the current pathname as
 * standard context so the dashboard groups errors by route.
 */
export function captureException(
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!initialized) {
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.debug("[analytics] (no-op exception)", error, properties);
    }
    return;
  }
  const err = error instanceof Error ? error : new Error(String(error));
  posthog.captureException(err, {
    pathname: window.location.pathname,
    ...properties,
  });
}

export function identify(
  userId: string,
  properties?: Record<string, unknown>,
): void {
  if (!initialized) return;
  posthog.identify(userId, properties);
}

export function reset(): void {
  if (!initialized) return;
  posthog.reset();
}
