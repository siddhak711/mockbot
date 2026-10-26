import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openComputer, selectSandboxBackend } from "../src/sandbox/open";
import { SandboxStore } from "../src/sandbox/store";

it("selects Postgres on DATABASE_URL, Vercel, and production, and PGlite on disk in dev", () => {
  expect(selectSandboxBackend({ DATABASE_URL: "postgres://db.example/mockbot" })).toEqual({
    kind: "database",
  });
  expect(selectSandboxBackend({ DATABASE_URL: "  postgres://db.example/mockbot  " })).toEqual({
    kind: "database",
  });
  expect(selectSandboxBackend({ VERCEL: "1" })).toEqual({ kind: "database" });
  expect(selectSandboxBackend({ NODE_ENV: "production" })).toEqual({ kind: "database" });
  expect(
    selectSandboxBackend(
      { DATABASE_URL: "postgres://db.example/mockbot", SANDBOX_DATA_DIR: ".data/sandbox" },
      ".data/sandbox",
    ),
  ).toEqual({ kind: "database" });
  expect(selectSandboxBackend({ VERCEL: "1" }, ".data/sandbox")).toEqual({ kind: "database" });
  expect(selectSandboxBackend({})).toEqual({ kind: "pglite", dataDir: ".data/sandbox" });
  expect(selectSandboxBackend({ SANDBOX_DATA_DIR: "  " })).toEqual({
    kind: "pglite",
    dataDir: ".data/sandbox",
  });
  expect(selectSandboxBackend({ SANDBOX_DATA_DIR: "var/sandbox" })).toEqual({
    kind: "pglite",
    dataDir: "var/sandbox",
  });
  expect(selectSandboxBackend({}, "memory://")).toEqual({ kind: "pglite", dataDir: "memory://" });
});

it("does not create a data directory when Vercel or production has no DATABASE_URL", async () => {
  const dir = join(tmpdir(), `mockbot-sandbox-readonly-${crypto.randomUUID()}`);
  expect(existsSync(dir)).toBe(false);
  await expect(
    openComputer({
      env: { NODE_ENV: "production", SANDBOX_DATA_DIR: dir, DATA_DIR: dir },
      dataDir: dir,
    }),
  ).rejects.toThrow(/DATABASE_URL/);
  await expect(
    openComputer({ env: { VERCEL: "1", SANDBOX_DATA_DIR: dir }, dataDir: dir }),
  ).rejects.toThrow(/DATABASE_URL/);
  expect(existsSync(dir)).toBe(false);
});

it("keeps the dev sandbox on local PGlite and reopens the same files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-sandbox-"));
  try {
    const first = await openComputer({ env: { SANDBOX_DATA_DIR: dir } });
    expect(first.driver).toBe("pglite");
    await first.invoke("agent", "write", { path: "hello.txt", content: "local disk" });
    await first.close();

    const second = await openComputer({ env: {}, dataDir: dir });
    expect(second.driver).toBe("pglite");
    const read = await second.invoke("agent", "read", { path: "hello.txt" });
    expect(read.run.stdout).toBe("local disk");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeComputer(env: Record<string, string | undefined>, driver: "pglite" | "neon") {
  const agentId = `test-${crypto.randomUUID()}`;
  const store = await SandboxStore.connect(env);
  try {
    const computer = await store.ensureComputer(agentId, "mock");
    await store.writeFile(agentId, "hello.txt", "hello from postgres");
    const run = await store.insertRun({
      agentId,
      tool: "exec",
      command: "cat hello.txt",
      arguments: { command: "cat hello.txt" },
      stdout: "hello from postgres",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      changedFiles: ["hello.txt"],
    });
    expect(store.driver).toBe(driver);
    expect(run.arguments).toEqual({ command: "cat hello.txt" });
    expect(run.changedFiles).toEqual(["hello.txt"]);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(await store.readFile(agentId, "hello.txt")).toBe("hello from postgres");
    expect(await store.listPaths(agentId)).toEqual(["hello.txt"]);
    return { agentId, computerId: computer.id };
  } finally {
    await store.close();
  }
}

async function roundTrip(env: Record<string, string | undefined>, driver: "pglite" | "neon") {
  const { agentId, computerId } = await writeComputer(env, driver);

  const again = await SandboxStore.connect(env);
  try {
    expect(again.driver).toBe(driver);
    expect((await again.getComputer(agentId))?.id).toBe(computerId);
    expect(await again.readFile(agentId, "hello.txt")).toBe("hello from postgres");
    expect((await again.listRuns(agentId))[0]?.stdout).toBe("hello from postgres");
  } finally {
    await again.connection.query("DELETE FROM sandbox_runs WHERE agent_id = $1", [agentId]);
    await again.connection.query("DELETE FROM sandbox_files WHERE agent_id = $1", [agentId]);
    await again.connection.query("DELETE FROM computers WHERE agent_id = $1", [agentId]);
    await again.close();
  }
}

it("creates sandbox tables through openDatabase and round-trips a computer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-sandbox-db-"));
  try {
    await roundTrip({ DATA_DIR: dir }, "pglite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const databaseUrl = process.env.DATABASE_URL?.trim();
const suite = databaseUrl ? describe : describe.skip;

suite("postgres sandbox store", () => {
  it("creates sandbox tables on Neon and round-trips a computer", async () => {
    await roundTrip({ DATABASE_URL: databaseUrl, NODE_ENV: "production" }, "neon");
  });

  it("opens the computer on Neon and ignores a local sandbox directory", async () => {
    const dir = join(tmpdir(), `mockbot-sandbox-neon-${crypto.randomUUID()}`);
    const supervisor = await openComputer({
      env: {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        VERCEL: "1",
        SANDBOX_DATA_DIR: dir,
        DATA_DIR: dir,
      },
      dataDir: dir,
    });
    try {
      expect(supervisor.driver).toBe("neon");
      expect(existsSync(dir)).toBe(false);
    } finally {
      await supervisor.close();
    }
  });
});
