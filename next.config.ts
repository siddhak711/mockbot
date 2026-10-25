import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  devIndicators: false,
  serverExternalPackages: ["@electric-sql/pglite", "@modelcontextprotocol/client"],
  outputFileTracingIncludes: {
    "/**": ["./src/db/migrations/**/*.sql"],
  },
};

export default nextConfig;
