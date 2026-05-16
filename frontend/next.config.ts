import type { NextConfig } from "next";

// Hosts allowed to load /_next/* dev resources from this dev server.
// Next.js 16 blocks cross-origin dev requests by default; without this,
// running `next dev` behind any reverse proxy or non-localhost origin
// silently breaks HMR and React hydration.
// Set ALLOWED_DEV_ORIGINS as a comma-separated list, e.g.
//   ALLOWED_DEV_ORIGINS=bigset.example.com,staging.example.com
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  async rewrites() {
    return [
      {
        source: "/api/auth/:path*",
        destination: `${process.env.BACKEND_URL || "http://localhost:3501"}/api/auth/:path*`,
      },
    ];
  },
};

export default nextConfig;
