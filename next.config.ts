import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  devIndicators: false,
  // app/icon.svg is served at /icon.svg. /icon is the same file.
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
