import "dotenv/config";

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

  // Used by ./clerk-auth.ts to verify JWTs on user-facing routes. Optional
  // today because no protected routes exist yet; required as soon as one is
  // added.
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};
