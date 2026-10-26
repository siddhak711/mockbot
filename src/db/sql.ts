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

export function splitSql(script: string): string[] {
  return script
    .split(";")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((part) => part.length > 0);
}
