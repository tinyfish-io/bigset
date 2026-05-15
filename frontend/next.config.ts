import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
