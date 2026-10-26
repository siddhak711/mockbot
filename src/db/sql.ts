export type SqlDriver = "pglite" | "neon";

export type SqlRows<T> = { rows: T[] };

export interface Sql {
  readonly driver: SqlDriver;
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlRows<T>>;
  exec(script: string): Promise<void>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Split a script on semicolons. Dollar-quoted bodies stay intact so a DO block
 * can update optional tables. Line comments outside those bodies are dropped.
 */
export function splitSql(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let dollar: string | null = null;
  let index = 0;
  while (index < script.length) {
    if (!dollar && script.startsWith("--", index)) {
      const end = script.indexOf("\n", index);
      index = end === -1 ? script.length : end + 1;
      continue;
    }
    if (script[index] === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(script.slice(index));
      if (match) {
        const tag = match[0];
        if (!dollar) dollar = tag;
        else if (dollar === tag) dollar = null;
        current += tag;
        index += tag.length;
        continue;
      }
    }
    if (!dollar && script[index] === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      index += 1;
      continue;
    }
    current += script[index];
    index += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
