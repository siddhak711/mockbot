import { openNeon } from "./neon";
import { openPglite } from "./pglite";
import type { Sql } from "./sql";

export type ProcessEnv = Record<string, string | undefined>;

export function isHostedRuntime(env: ProcessEnv): boolean {
  return env.VERCEL === "1" || env.NODE_ENV === "production";
}

export async function openDatabase(env: ProcessEnv): Promise<Sql> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) return openNeon(databaseUrl);
  if (isHostedRuntime(env)) {
    throw new Error(
      "DATABASE_URL is required in production and on Vercel. Mockbot does not use embedded PGlite, /tmp files, or blob snapshots there. Use the pooled Neon connection string.",
    );
  }
  const dataDir = env.DATA_DIR?.trim() || ".data/pglite";
  return openPglite(dataDir);
}
