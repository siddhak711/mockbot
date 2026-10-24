import { neon, type FullQueryResults } from "@neondatabase/serverless";
import { splitSql, type Sql } from "./sql";

export function openNeon(databaseUrl: string): Sql {
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("DATABASE_URL must be a postgres connection string.");
  }
  const sql = neon<false, true>(databaseUrl, { fullResults: true });
  return {
    driver: "neon",
    async query<T>(text: string, params: readonly unknown[] = []) {
      const result = (await sql.query(text, [...params])) as FullQueryResults<false>;
      return { rows: result.rows as T[] };
    },
    async exec(script: string) {
      for (const statement of splitSql(script)) {
        await sql.query(statement);
      }
    },
    async close() {},
  };
}
