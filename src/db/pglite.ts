import { mkdir } from "node:fs/promises";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { splitSql, type Sql } from "./sql";

type Queryable = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(script: string): Promise<unknown>;
};

function asSql(
  queryable: Queryable,
  transaction: Sql["transaction"],
  close: () => Promise<void>,
): Sql {
  return {
    driver: "pglite",
    async query<T>(text: string, params: readonly unknown[] = []) {
      const result = await queryable.query<T>(text, [...params]);
      return { rows: result.rows };
    },
    async exec(script: string) {
      for (const statement of splitSql(script)) {
        await queryable.exec(statement.endsWith(";") ? statement : `${statement};`);
      }
    },
    transaction,
    close,
  };
}

export async function openPglite(dataDir?: string): Promise<Sql> {
  const persistent = Boolean(dataDir && !dataDir.startsWith("memory:"));
  if (persistent && dataDir) await mkdir(dataDir, { recursive: true });
  const db = new PGlite(persistent && dataDir ? dataDir : "memory://");
  await db.waitReady;
  let closed = false;

  const bindTx = (tx: Transaction): Sql =>
    asSql(
      tx,
      async (fn) => fn(bindTx(tx)),
      async () => {},
    );

  return asSql(
    db,
    (fn) => db.transaction(async (tx) => fn(bindTx(tx))),
    async () => {
      if (closed || db.closed) return;
      closed = true;
      await db.close();
    },
  );
}
