import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || "http://localhost:3500",
  CONVEX_URL: required("CONVEX_URL"),
  PORT: Number(process.env.PORT || "3501"),

  // Used by ./convex.ts to call internal Convex functions (e.g. agent-driven
  // row inserts). Optional today because no scheduled jobs run yet; required
  // once the agent runner actually writes to Convex.
  CONVEX_ADMIN_KEY: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,

  // Used by ./clerk-auth.ts to verify JWTs on protected routes (e.g.
  // /infer-schema). Required for the backend to function.
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_PUBLISHABLE_KEY:
    process.env.CLERK_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,

  // Hard cap on the number of fully-complete rows the populate agent will
  // insert per run. The agent stops as soon as this count is reached.
  // Override with BIGSET_POPULATE_TARGET_ROWS=N in the root .env file.
  // Invalid values (NaN, ≤0, non-integer) fall back to the default of 20.
  POPULATE_TARGET_ROWS: (() => {
    const parsed = Number(process.env.BIGSET_POPULATE_TARGET_ROWS);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
  })(),

  // Resend (transactional email). Optional — when RESEND_API_KEY is unset
  // the email module no-ops with a log line, so local dev works without
  // a Resend account. EMAIL_FROM must be a domain that's verified in the
  // Resend dashboard.
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM || "BigSet <simantak@tinyfish.ai>",

  // PostHog (server-side analytics for events the frontend can't observe —
  // currently just the transactional email lifecycle). Same project key
  // as the frontend (`phc_...`); events identify by Clerk userId so they
  // associate to the same user the frontend already identified.
  // No-op when unset.
  POSTHOG_KEY: process.env.POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY,
  POSTHOG_HOST:
    process.env.POSTHOG_HOST ||
    process.env.NEXT_PUBLIC_POSTHOG_HOST ||
    "https://us.i.posthog.com",
};
