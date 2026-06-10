import type { AuthConfig } from "convex/server";

const isLocalMode = process.env.BIGSET_LOCAL_MODE === "1";
const clerkIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN;

if (!isLocalMode && !clerkIssuer) {
  throw new Error("CLERK_JWT_ISSUER_DOMAIN is required outside local mode");
}

export default {
  providers: !isLocalMode && clerkIssuer
    ? [
        {
          domain: clerkIssuer,
          applicationID: "convex",
        },
      ]
    : [],
} satisfies AuthConfig;
