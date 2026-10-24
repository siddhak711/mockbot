import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
