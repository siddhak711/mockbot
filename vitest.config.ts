import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // next-auth imports the extensionless CJS entry. Node's ESM loader
      // (used for Vitest's externalized deps) only resolves next/server.js.
      "next/server": path.join(root, "node_modules/next/server.js"),
    },
  },
  test: {
    server: {
      deps: {
        // next-auth's `next/server` import is extensionless. Inlining lets Vite
        // resolve it; Node's ESM loader does not.
        inline: ["next-auth"],
      },
    },
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    env: {
      AUTH_SECRET: "test-only-auth-secret-0123456789abcdef",
      AUTH_URL: "http://localhost:3000",
    },
  },
});
