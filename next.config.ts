import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  devIndicators: false,
  serverExternalPackages: ["@electric-sql/pglite", "@neondatabase/serverless"],
};

export default nextConfig;
