import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { splitSql, type Sql } from "./sql";

export async function openPglite(dataDir?: string): Promise<Sql> {
  const persistent = Boolean(dataDir && !dataDir.startsWith("memory:"));
  if (persistent && dataDir) await mkdir(dataDir, { recursive: true });
  const db = new PGlite(persistent && dataDir ? dataDir : "memory://");
  await db.waitReady;
  let closed = false;
  return {
    driver: "pglite",
    async query<T>(text: string, params: readonly unknown[] = []) {
      const result = await db.query<T>(text, [...params]);
      return { rows: result.rows };
    },
    async exec(script: string) {
      for (const statement of splitSql(script)) {
        await db.exec(statement.endsWith(";") ? statement : `${statement};`);
      }
    },
    async close() {
      if (closed || db.closed) return;
      closed = true;
      await db.close();
    },
  };
}
