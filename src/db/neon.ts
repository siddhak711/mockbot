import { neon, neonConfig, Pool, type FullQueryResults } from "@neondatabase/serverless";
import { splitSql, type Sql } from "./sql";

export type NeonSession = {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
};

export type NeonPool = {
  connect(): Promise<NeonSession>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): void;
};

/**
 * Interactive transactions need a WebSocket session. The HTTP driver cannot
 * hold BEGIN, FOR UPDATE, and COMMIT across a callback, so a missing
 * constructor must fail instead of running each statement on its own.
 */
export function assertWebSocketConstructor(
  available: unknown,
): asserts available is typeof WebSocket {
  if (typeof available !== "function") {
    throw new Error(
      "Neon transactions need a WebSocket constructor so BEGIN and COMMIT share one connection. Node 22 provides WebSocket; otherwise set neonConfig.webSocketConstructor before opening the database.",
    );
  }
}

export function ensureNeonWebSocket(): void {
  const available = neonConfig.webSocketConstructor ?? globalThis.WebSocket;
  assertWebSocketConstructor(available);
  if (!neonConfig.webSocketConstructor) neonConfig.webSocketConstructor = available;
}

type TxPhase = "idle" | "open" | "closed";

export async function runNeonTransaction<T>(
  session: NeonSession,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const phase: { current: TxPhase } = { current: "idle" };
  let released = false;
  const release = (err?: Error | boolean) => {
    if (released) return;
    released = true;
    session.release(err);
  };
  const tx = sessionSql(session, phase);
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    if (phase.current === "open") {
      try {
        await tx.query("ROLLBACK");
      } catch (rollbackError) {
        release(rollbackError instanceof Error ? rollbackError : true);
        throw error;
      }
    }
    throw error;
  } finally {
    release();
  }
}

function sessionSql(session: NeonSession, phase: { current: TxPhase }): Sql {
  return {
    driver: "neon",
    async query<T>(text: string, params: readonly unknown[] = []) {
      const command = text.trim().split(/\s+/)[0]?.toUpperCase();
      if (command === "BEGIN") {
        if (phase.current !== "idle") {
          throw new Error("A Neon transaction is already open on this connection.");
        }
      } else if (command === "COMMIT" || command === "ROLLBACK") {
        if (phase.current !== "open") {
          throw new Error("Cannot end a Neon transaction that is not open.");
        }
      } else if (phase.current !== "open") {
        throw new Error(
          "Refusing a Neon query outside a transaction. Agent grants and routine locks must commit or roll back together.",
        );
      }
      const result = await session.query(text, params);
      if (command === "BEGIN") phase.current = "open";
      if (command === "COMMIT" || command === "ROLLBACK") phase.current = "closed";
      return { rows: (result.rows ?? []) as T[] };
    },
    async exec(script: string) {
      for (const statement of splitSql(script)) {
        await this.query(statement);
      }
    },
    transaction(inner) {
      return inner(sessionSql(session, phase));
    },
    async close() {
      throw new Error(
        "Close the Neon pool from the outer connection, not from inside a transaction.",
      );
    },
  };
}

export function openNeon(databaseUrl: string, options?: { pool?: NeonPool }): Sql {
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("DATABASE_URL must be a postgres connection string.");
  }
  const sql = neon<false, true>(databaseUrl, { fullResults: true });
  const pool = options?.pool ?? createPool(databaseUrl);
  let ended = false;
  const db: Sql = {
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
    transaction(fn) {
      return pool.connect().then((session) => runNeonTransaction(session, fn));
    },
    async close() {
      if (ended) return;
      ended = true;
      await pool.end();
    },
  };
  return db;
}

function createPool(databaseUrl: string): NeonPool {
  ensureNeonWebSocket();
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error: Error) => {
    console.error("Neon pool error", error.message);
  });
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text: string, params?: readonly unknown[]) {
          const result = await client.query(text, params ? [...params] : []);
          return { rows: (result.rows ?? []) as unknown[] };
        },
        release(err) {
          client.release(err);
        },
      };
    },
    end() {
      return pool.end();
    },
  };
}
