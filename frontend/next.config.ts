import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_PROD: process.env.NEXT_PUBLIC_PROD ?? process.env.PROD ?? "",
  },
};

export default nextConfig;
