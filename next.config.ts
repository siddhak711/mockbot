import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  devIndicators: false,
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@neondatabase/serverless",
    "@daytonaio/sdk",
    "@modelcontextprotocol/client",
  ],
  outputFileTracingIncludes: {
    "/**": ["./src/db/migrations/**/*.sql"],
  },
};

export default nextConfig;
