import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  devIndicators: false,
  async rewrites() {
    return [{ source: "/icon", destination: "/icon.svg" }];
  },
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
