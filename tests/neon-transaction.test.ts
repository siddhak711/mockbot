import { expect, it } from "vitest";
import { assertWebSocketConstructor, openNeon, type NeonSession } from "../src/db/neon";

it("refuses a Neon transaction when no WebSocket constructor is available", () => {
  expect(() => assertWebSocketConstructor(undefined)).toThrow(/WebSocket/);
  expect(() => assertWebSocketConstructor(null)).toThrow(/WebSocket/);
});

it("rolls back an agent grant write on one Neon session instead of committing each statement", async () => {
  const log: string[] = [];
  let released = 0;
  const session: NeonSession = {
    async query(text: string) {
      log.push(text);
      if (text.startsWith("INSERT INTO agent_grants")) throw new Error("grant failed");
      return { rows: [{ id: "agent-1" }] };
    },
    release() {
      released += 1;
    },
  };
  const db = openNeon("postgres://user:pass@localhost/db", {
    pool: {
      async connect() {
        return session;
      },
      async end() {
        log.push("end");
      },
    },
  });

  await expect(
    db.transaction(async (tx) => {
      await tx.query("INSERT INTO agents (id) VALUES ($1)", ["a"]);
      await tx.query("INSERT INTO agent_grants (id) VALUES ($1)", ["g"]);
      return "ok";
    }),
  ).rejects.toThrow("grant failed");

  expect(log).toEqual([
    "BEGIN",
    "INSERT INTO agents (id) VALUES ($1)",
    "INSERT INTO agent_grants (id) VALUES ($1)",
    "ROLLBACK",
  ]);
  expect(released).toBe(1);
  await db.close();
  expect(log.at(-1)).toBe("end");
});

it("holds a routine row lock on one Neon session until commit", async () => {
  const log: string[] = [];
  const db = openNeon("postgres://user:pass@localhost/db", {
    pool: {
      async connect() {
        return {
          async query(text: string) {
            log.push(text.split(/\s+/)[0] ?? text);
            return { rows: [{ id: "routine-1" }] };
          },
          release() {},
        };
      },
      async end() {},
    },
  });

  const inserted = await db.transaction(async (tx) => {
    const locked = await tx.query<{ id: string }>(
      "SELECT id FROM routines WHERE id = $1 FOR UPDATE SKIP LOCKED",
      ["routine-1"],
    );
    expect(locked.rows).toEqual([{ id: "routine-1" }]);
    await tx.transaction(async (inner) => {
      await inner.query("UPDATE routines SET next_run_at = $2 WHERE id = $1", [
        "routine-1",
        "later",
      ]);
    });
    return true;
  });

  expect(inserted).toBe(true);
  expect(log).toEqual(["BEGIN", "SELECT", "UPDATE", "COMMIT"]);
  await db.close();
});
