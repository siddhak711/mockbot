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

function stripLineComments(part: string): string {
  return part
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

/** Split a SQL script on semicolons that are outside quotes and dollar-quoted bodies. */
export function splitSql(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  let dollar: string | null = null;
  let inSingle = false;
  while (index < script.length) {
    const char = script[index] ?? "";
    if (dollar) {
      if (script.startsWith(dollar, index)) {
        current += dollar;
        index += dollar.length;
        dollar = null;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (inSingle) {
      current += char;
      if (char === "'" && script[index + 1] === "'") {
        current += "'";
        index += 2;
        continue;
      }
      if (char === "'") inSingle = false;
      index += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      current += char;
      index += 1;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(script.slice(index));
      if (tag) {
        dollar = tag[0];
        current += dollar;
        index += dollar.length;
        continue;
      }
    }
    if (char === "-" && script[index + 1] === "-") {
      const newline = script.indexOf("\n", index);
      index = newline === -1 ? script.length : newline + 1;
      current += "\n";
      continue;
    }
    if (char === ";") {
      const statement = stripLineComments(current);
      if (statement) statements.push(statement);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  const tail = stripLineComments(current);
  if (tail) statements.push(tail);
  return statements;
}
