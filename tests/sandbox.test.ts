import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/computer/route";
import { resetAppContext, setAppContext } from "../src/context";
import { withAgentMock } from "../src/agents/mock-script";
import { MockProvider } from "../src/llm";
import { commandTimeoutMs, resolveWorkspacePath, toSandboxPath } from "../src/sandbox/limits";
import { openComputer } from "../src/sandbox/open";
import { planComputerTurn } from "../src/sandbox/plan";
import type { ExecOutcome, SandboxEntry, SandboxRuntime } from "../src/sandbox/runtime";
import { ComputerSupervisor, DIFF_MAX_BYTES, DIFF_MAX_FILES } from "../src/sandbox/supervisor";
import { SandboxStore } from "../src/sandbox/store";
import { createComputerTools } from "../src/sandbox/tools";
import { SandboxTurnProvider } from "../src/sandbox/turn";
import { ConversationStore } from "../src/store";
import {
  DaytonaRuntime,
  daytonaCreateParams,
  readDaytonaSettings,
  type RemoteSandbox,
  type RemoteSandboxFleet,
} from "../src/sandbox/daytona";
import { readSse } from "./helpers";

describe("sandbox", { concurrent: false }, () => {
  const DEMO =
    "Create a file named hello.txt that says hello from the sandbox, read it back, and run a command that prints it.";

  afterEach(async () => {
    await resetAppContext();
  });

  it("plans a file write, a read, and a command that prints the file", () => {
    expect(planComputerTurn(DEMO)).toEqual([
      { name: "write", args: { path: "hello.txt", content: "hello from the sandbox" } },
      { name: "read", args: { path: "hello.txt" } },
      { name: "exec", args: { command: "cat hello.txt" } },
    ]);
    expect(planComputerTurn("Say hello")).toBeNull();
    expect(planComputerTurn("Remember this")).toBeNull();
    expect(planComputerTurn("run `echo hi`")).toEqual([
      { name: "exec", args: { command: "echo hi" } },
    ]);
  });

  it("leaves a delegate phrase to the agent mock and lets a child plan use_computer", async () => {
    const provider = new SandboxTurnProvider({
      inner: withAgentMock(new MockProvider({ delayMs: 0, chunkSize: 80 })),
      delayMs: 0,
    });
    const task =
      "Create a file named notes.txt that says hello from the sandbox, read it back, and run a command that prints it.";
    const delegated = await toolNames(provider, [
      { role: "system", content: "You are Mockbot." },
      { role: "user", content: `delegate to Researcher: ${task}` },
    ]);
    expect(delegated).toEqual(["delegate"]);

    const child = await toolNames(provider, [
      {
        role: "system",
        content: [
          "You study groves.",
          "",
          "# Agent",
          "name: Researcher",
          "delegation: child",
          "computers: desk",
          "Use use_computer only for a listed computer and use_connector only for a listed connector.",
        ].join("\n"),
      },
      { role: "user", content: task },
    ]);
    expect(child).toEqual(["use_computer"]);

    const own = await toolNames(provider, [{ role: "user", content: DEMO }]);
    expect(own).toEqual(["write"]);
  });

  it("keeps paths inside the workspace", () => {
    expect(resolveWorkspacePath("hello.txt")).toEqual({ path: "hello.txt" });
    expect(resolveWorkspacePath("../.env")).toEqual({
      error: "Path is outside the sandbox workspace.",
    });
    const outside = resolveWorkspacePath("/workspace/.env");
    expect("error" in outside ? outside.error : "").toMatch(/outside/);
    expect(toSandboxPath("hello.txt")).toBe("workspace/hello.txt");
    expect(commandTimeoutMs({})).toBe(10_000);
    expect(commandTimeoutMs({ SANDBOX_COMMAND_TIMEOUT_MS: "250" })).toBe(250);
  });

  it("creates a file, reads it back, and runs a command that prints it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supervisor = await openComputer({ env: {}, dataDir: "memory://" });
    const write = await supervisor.invoke("agent", "write", {
      path: "hello.txt",
      content: "hello from the sandbox",
    });
    const read = await supervisor.invoke("agent", "read", { path: "hello.txt" });
    const exec = await supervisor.invoke("agent", "exec", { command: "cat hello.txt" });

    expect(write.result.isError).toBeUndefined();
    expect(write.run.changedFiles).toEqual(["hello.txt"]);
    expect(read.result.content).toContain("hello from the sandbox");
    expect(read.result.content.startsWith('{"provider":"mock"}\n')).toBe(true);
    expect(exec.result.content.startsWith('{"provider":"mock"}\n')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "sandbox is using a mock implementation because DAYTONA_API_KEY is not set.",
    );
    warn.mockRestore();
    expect(exec.result.isError).toBeUndefined();
    expect(exec.run.command).toBe("cat hello.txt");
    expect(exec.run.stdout).toBe("hello from the sandbox");
    expect(exec.run.exitCode).toBe(0);
    expect(exec.run.timedOut).toBe(false);

    const snapshot = await supervisor.snapshot("agent");
    expect(snapshot.provider).toBe("mock");
    expect(snapshot.files.map((file) => file.path)).toEqual(["hello.txt"]);
    expect(snapshot.runs[0]?.exitCode).toBe(0);
    await supervisor.close();
  });

  it("does not read the host environment file or another agent's workspace, and does not spawn a host shell", async () => {
    const canary = "host-env-canary-9f3a2c";
    const directory = mkdtempSync(join(tmpdir(), "mockbot-host-"));
    const hostEnv = join(directory, ".env");
    writeFileSync(hostEnv, `DAYTONA_API_KEY=${canary}\n`);
    const previous = process.env.HOST_ENV_CANARY;
    process.env.HOST_ENV_CANARY = canary;

    const supervisor = await openComputer({
      env: { HOST_ENV_CANARY: canary },
      dataDir: "memory://",
    });
    try {
      await supervisor.invoke("agent-a", "write", {
        path: "secret.txt",
        content: `agent-secret-${canary}`,
      });
      const attempts = [];
      for (const run of [
        () => supervisor.invoke("agent-b", "read", { path: "secret.txt" }),
        () => supervisor.invoke("agent-b", "read", { path: hostEnv }),
        () => supervisor.invoke("agent-b", "read", { path: "../.env" }),
        () => supervisor.invoke("agent-b", "read", { path: ".env" }),
        () => supervisor.invoke("agent-b", "list", { path: "." }),
        () => supervisor.invoke("agent-b", "exec", { command: `cat ${hostEnv}` }),
        () => supervisor.invoke("agent-b", "exec", { command: "cat ../.env" }),
        () => supervisor.invoke("agent-b", "exec", { command: "cat .env" }),
        () => supervisor.invoke("agent-b", "exec", { command: "printenv HOST_ENV_CANARY" }),
        () => supervisor.invoke("agent-b", "exec", { command: "printenv" }),
        () => supervisor.invoke("agent-b", "exec", { command: "cat secret.txt" }),
      ]) {
        attempts.push(await run());
      }
      const blob = JSON.stringify(attempts);
      expect(blob).not.toContain(canary);
      expect(blob).not.toContain(`agent-secret-${canary}`);
      const listed = attempts[4];
      expect(listed?.run.stdout).not.toContain("secret.txt");
      for (const file of walk("src/sandbox")) {
        const source = readFileSync(file, "utf8");
        expect(source, file).not.toContain("child_process");
        expect(source, file).not.toMatch(/\bspawn(Sync)?\s*\(/);
        expect(source, file).not.toMatch(/\bexec(File)?Sync\s*\(/);
      }

      const own = await supervisor.invoke("agent-a", "read", { path: "secret.txt" });
      expect(own.result.content).toContain(`agent-secret-${canary}`);
    } finally {
      if (previous === undefined) delete process.env.HOST_ENV_CANARY;
      else process.env.HOST_ENV_CANARY = previous;
      await supervisor.close();
    }
  });

  it("kills a command that exceeds its time limit and reports a failed tool result", async () => {
    const supervisor = await openComputer({
      env: { SANDBOX_COMMAND_TIMEOUT_MS: "40" },
      dataDir: "memory://",
    });
    const started = Date.now();
    const result = await supervisor.invoke("agent", "exec", { command: "sleep 30" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toMatch(/killed/);
    expect(result.result.content).toContain("exit_code: null");
    expect(result.run.timedOut).toBe(true);
    expect(result.run.exitCode).toBeNull();
    expect(result.run.stdout).toMatch(/killed/);
    await supervisor.close();
  });

  it("reports a failed tool result when the runtime never finishes", async () => {
    const store = await SandboxStore.open("memory://");
    const supervisor = new ComputerSupervisor(store, new HangingRuntime(), 30);
    const started = Date.now();
    const result = await supervisor.invoke("agent", "exec", { command: "sleep 30" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.result.isError).toBe(true);
    expect(result.run.timedOut).toBe(true);
    await supervisor.close();
  });

  it("keeps Daytona credentials on the server and gives each agent its own sandbox", async () => {
    const secret = "daytona-secret-canary";
    expect(readDaytonaSettings({})).toBeNull();
    expect(
      readDaytonaSettings({
        DAYTONA_API_KEY: secret,
        DAYTONA_API_URL: "https://example.test/api",
        DAYTONA_TARGET: "us",
      }),
    ).toEqual({ apiKey: secret, apiUrl: "https://example.test/api", target: "us" });
    expect(daytonaCreateParams("agent")).toEqual({
      language: "python",
      labels: { app: "mockbot", agentId: "agent" },
    });
    expect(daytonaCreateParams("agent")).not.toHaveProperty("envVars");
    expect(daytonaCreateParams("agent")).not.toHaveProperty("secrets");

    const source = readFileSync(join("src", "sandbox", "daytona.ts"), "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("...process.env");
    expect(source).not.toContain("envVars: process.env");
    expect(source).toMatch(/executeCommand\(\s*command,\s*cwd,\s*undefined,\s*timeoutSec,?\s*\)/);
    expect(source).toContain("Buffer.from(content)");
    expect(source).toMatch(/downloadFile\(remotePath\)/);

    const fleet = new FakeFleet();
    const store = await SandboxStore.open("memory://");
    const runtime = new DaytonaRuntime(fleet, store, secret);
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    await supervisor.invoke("agent-a", "write", { path: "note.txt", content: "from-a" });
    await supervisor.invoke("agent-a", "read", { path: "note.txt" });
    expect(fleet.creates).toHaveLength(1);
    expect(fleet.creates[0]?.envVars).toBeUndefined();
    expect(JSON.stringify(fleet.creates)).not.toContain(secret);

    const other = await supervisor.invoke("agent-b", "read", { path: "note.txt" });
    expect(other.result.isError).toBe(true);
    expect(other.result.content).not.toContain("from-a");
    expect(fleet.creates).toHaveLength(2);
    expect(fleet.creates[0]?.id).not.toBe(fleet.creates[1]?.id);

    const again = await supervisor.invoke("agent-a", "exec", { command: "cat note.txt" });
    expect(again.run.stdout).toContain("from-a");
    expect(again.result.content).not.toContain('"provider": "mock"');
    expect(again.run.exitCode).toBe(0);
    expect(fleet.execs.at(-1)).toMatchObject({ cwd: "workspace", timeoutSec: 1 });
    expect(fleet.creates).toHaveLength(2);

    const snapshot = await supervisor.snapshot("agent-c");
    expect(snapshot.files).toEqual([]);
    expect(fleet.creates).toHaveLength(2);

    await supervisor.close();
  });

  it("does not count sandbox startup against the command timeout", async () => {
    const fleet = new FakeFleet();
    fleet.bootMs = 80;
    const store = await SandboxStore.open("memory://");
    const runtime = new DaytonaRuntime(fleet, store, "secret");
    const supervisor = new ComputerSupervisor(store, runtime, 30);
    const started = Date.now();
    const result = await supervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(result.run.timedOut).toBe(false);
    expect(result.run.exitCode).toBe(0);
    expect(result.run.stdout).toBe("hi\n");
    expect(result.result.isError).toBeUndefined();
    expect(fleet.creates).toHaveLength(1);
    await supervisor.close();
  });

  it("creates one sandbox and one computer row when the first calls overlap", async () => {
    const store = await SandboxStore.open("memory://");
    const [first, second] = await Promise.all([
      store.ensureComputer("agent-lock", "daytona"),
      store.ensureComputer("agent-lock", "daytona"),
    ]);
    expect(first.id).toBe(second.id);
    expect(await store.countComputers("agent-lock")).toBe(1);

    const fleet = new FakeFleet();
    fleet.bootMs = 40;
    const runtime = new DaytonaRuntime(fleet, store, "secret");
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    const [left, right] = await Promise.all([
      supervisor.invoke("agent-lock", "exec", { command: "echo one" }),
      supervisor.invoke("agent-lock", "exec", { command: "echo two" }),
    ]);
    expect(fleet.creates).toHaveLength(1);
    expect(left.run.timedOut).toBe(false);
    expect(right.run.timedOut).toBe(false);
    expect(left.run.exitCode).toBe(0);
    expect(right.run.exitCode).toBe(0);
    expect(await store.countComputers("agent-lock")).toBe(1);
    expect((await store.getComputer("agent-lock"))?.sandboxId).toBe(fleet.creates[0]?.id);
    await supervisor.close();
  });

  it("restarts a cached Daytona sandbox that has stopped", async () => {
    const fleet = new FakeFleet();
    const store = await SandboxStore.open("memory://");
    const runtime = new DaytonaRuntime(fleet, store, "secret");
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    const first = await supervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(first.run.exitCode).toBe(0);
    expect(fleet.creates).toHaveLength(1);
    expect(fleet.starts).toEqual([]);
    const id = fleet.creates[0]?.id ?? "";
    fleet.stop(id);

    const restarted = await supervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(restarted.run.exitCode).toBe(0);
    expect(restarted.run.timedOut).toBe(false);
    expect(restarted.run.stdout).toBe("hi\n");
    expect(fleet.starts).toEqual([id]);
    expect(fleet.reconnects).toEqual([]);
    expect(fleet.creates).toHaveLength(1);
    expect((await store.getComputer("agent"))?.sandboxId).toBe(id);

    fleet.stop(id);
    fleet.failNextStart = true;
    const recovered = await supervisor.invoke("agent", "exec", { command: "echo again" });
    expect(recovered.run.exitCode).toBe(0);
    expect(recovered.run.stdout).toBe("again\n");
    expect(fleet.reconnects).toEqual([id]);
    expect(fleet.creates).toHaveLength(1);
    expect((await store.getComputer("agent"))?.sandboxId).toBe(id);
    await supervisor.close();
  });

  it("cancels prepare and exec when the abort signal fires", async () => {
    const store = await SandboxStore.open("memory://");
    const runtime = new GateRuntime();
    const supervisor = new ComputerSupervisor(store, runtime, 5_000);

    const preparing = new AbortController();
    const sawPrepare = runtime.nextPrepare();
    const stoppedEarly = supervisor.invoke(
      "agent",
      "exec",
      { command: "echo hi" },
      preparing.signal,
    );
    await sawPrepare;
    preparing.abort();
    await expect(stoppedEarly).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.execCalls).toBe(0);
    expect(await store.listRuns("agent")).toEqual([]);

    const running = new AbortController();
    const sawPrepareAgain = runtime.nextPrepare();
    const sawExec = runtime.nextExec();
    const started = Date.now();
    const stoppedLate = supervisor.invoke("agent", "exec", { command: "echo hi" }, running.signal);
    await sawPrepareAgain;
    runtime.finishPrepare();
    await sawExec;
    running.abort();
    await expect(stoppedLate).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(runtime.execSignal?.aborted).toBe(true);
    expect(await store.listRuns("agent")).toEqual([]);
    await supervisor.close();
  });

  it("records files a command creates or edits", async () => {
    const fleet = new FakeFleet();
    const store = await SandboxStore.open("memory://");
    const runtime = new DaytonaRuntime(fleet, store, "secret");
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    await supervisor.invoke("agent", "write", { path: "keep.txt", content: "same" });
    await supervisor.invoke("agent", "write", { path: "note.txt", content: "old" });

    const revised = await supervisor.invoke("agent", "exec", { command: "revise" });
    expect(revised.run.changedFiles).toEqual(["created.txt", "note.txt"]);

    const reread = await supervisor.invoke("agent", "exec", { command: "revise" });
    expect(reread.run.changedFiles).toEqual([]);

    const printed = await supervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(printed.run.changedFiles).toEqual([]);
    await supervisor.close();
  });

  it("does not diff node_modules or .git, and records nothing when the tree is over the cap", async () => {
    const fleet = new FakeFleet();
    const store = await SandboxStore.open("memory://");
    const runtime = new DaytonaRuntime(fleet, store, "secret");
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    await supervisor.invoke("agent", "write", { path: "app.txt", content: "old" });
    await supervisor.invoke("agent", "write", {
      path: "node_modules/pkg/index.js",
      content: "module",
    });
    await supervisor.invoke("agent", "write", { path: ".git/config", content: "git" });
    fleet.reads.length = 0;

    const edited = await supervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(edited.run.changedFiles).toEqual([]);
    expect(fleet.reads.some((path) => path.includes("node_modules"))).toBe(false);
    expect(fleet.reads.some((path) => path.includes(".git"))).toBe(false);
    expect(fleet.reads.some((path) => path.endsWith("app.txt"))).toBe(true);
    await supervisor.close();

    const capped = await SandboxStore.open("memory://");
    await capped.ensureComputer("agent", "daytona");
    await capped.setSandboxId("agent", "sbx-cap");
    const wide = new CappedRuntime(DIFF_MAX_FILES + 1, 1);
    const wideSupervisor = new ComputerSupervisor(capped, wide, 1_000);
    const tooMany = await wideSupervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(tooMany.run.changedFiles).toEqual([]);
    expect(wide.reads).toBe(0);

    const heavyStore = await SandboxStore.open("memory://");
    await heavyStore.ensureComputer("agent", "daytona");
    await heavyStore.setSandboxId("agent", "sbx-heavy");
    const heavy = new CappedRuntime(1, DIFF_MAX_BYTES + 1);
    const heavySupervisor = new ComputerSupervisor(heavyStore, heavy, 1_000);
    const tooBig = await heavySupervisor.invoke("agent", "exec", { command: "echo hi" });
    expect(tooBig.run.changedFiles).toEqual([]);
    expect(heavy.reads).toBe(0);
    await wideSupervisor.close();
    await heavySupervisor.close();
  });

  it("aborts the file diff after a command when the signal fires", async () => {
    const store = await SandboxStore.open("memory://");
    await store.ensureComputer("agent", "daytona");
    await store.setSandboxId("agent", "sbx-abort");
    const controller = new AbortController();
    const runtime = new AbortAfterExecRuntime(controller);
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    await expect(
      supervisor.invoke("agent", "exec", { command: "echo hi" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.listRuns("agent")).toEqual([]);
    await supervisor.close();
  });

  it("lists nested Daytona files in the snapshot", async () => {
    const fleet = new FakeFleet();
    const store = await SandboxStore.open("memory://");
    const runtime = new DaytonaRuntime(fleet, store, "secret");
    const supervisor = new ComputerSupervisor(store, runtime, 1_000);
    await supervisor.invoke("agent", "write", { path: "notes/hello.txt", content: "nested" });
    await supervisor.invoke("agent", "write", { path: "top.txt", content: "top" });
    const snapshot = await supervisor.snapshot("agent");
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(["notes/hello.txt", "top.txt"]);
    const read = await supervisor.invoke("agent", "read", { path: "notes/hello.txt" });
    expect(read.run.stdout).toBe("nested");
    await supervisor.close();
  });

  it("streams the sandbox tools through chat and the computer API", async () => {
    const supervisor = await openComputer({ env: {}, dataDir: "memory://" });
    const store = await ConversationStore.open();
    setAppContext({
      store,
      sandbox: supervisor,
      provider: new SandboxTurnProvider({
        inner: new MockProvider({ delayMs: 0, chunkSize: 64 }),
        delayMs: 0,
      }),
    });

    const response = await POST_CHAT(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: DEMO }),
      }),
    );
    const events = await readSse(response);
    const tools = events.filter((event) => event.event === "tool_call");
    const names = tools
      .map((event) => (event.data as { name?: string }).name)
      .filter((name): name is string => Boolean(name));
    expect(names).toEqual(["write", "read", "exec"]);
    const execResult = events.find(
      (event) => event.event === "tool_result" && (event.data as { name?: string }).name === "exec",
    );
    const execText = String(
      (execResult?.data as { content?: string; output?: string }).output ??
        (execResult?.data as { content?: string }).content,
    );
    expect(execText).toContain("exit_code: 0");
    expect(execText).toContain("hello from the sandbox");

    const computer = await GET(new Request("http://localhost/api/computer"));
    expect(computer.status).toBe(200);
    const snapshot = (await computer.json()) as {
      provider: string;
      files: Array<{ path: string }>;
      runs: Array<{ command: string | null; stdout: string; exitCode: number | null }>;
    };
    expect(snapshot.provider).toBe("mock");
    expect(snapshot.files.map((file) => file.path)).toContain("hello.txt");
    const command = snapshot.runs.find((run) => run.command === "cat hello.txt");
    expect(command?.stdout).toBe("hello from the sandbox");
    expect(command?.exitCode).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain("DAYTONA_API_KEY");

    const direct = await POST(
      new Request("http://localhost/api/computer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "exec", command: "pwd" }),
      }),
    );
    const body = (await direct.json()) as { run: { stdout: string; exitCode: number } };
    expect(body.run.stdout).toBe("/workspace\n");
    expect(body.run.exitCode).toBe(0);
  });

  it("leaves an ordinary mock reply alone", async () => {
    const supervisor = await openComputer({ env: {}, dataDir: "memory://" });
    const store = await ConversationStore.open();
    const provider = new SandboxTurnProvider({
      inner: new MockProvider({ delayMs: 0, chunkSize: 80, reply: () => "Still a mock reply" }),
      delayMs: 0,
    });
    setAppContext({ store, sandbox: supervisor, provider });
    const { POST: chat } = await import("../app/api/chat/route");
    const response = await chat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Say hello" }),
      }),
    );
    const events = await readSse(response);
    expect(events.some((event) => event.event === "tool_call")).toBe(false);
    expect(events.map((event) => event.event)).toContain("delta");
    await supervisor.close();
  });

  it("exposes registry-shaped computer tools and keeps secrets out of browser code", () => {
    const tools = createComputerTools({
      invoke: () => {
        throw new Error("unused");
      },
    } as unknown as ComputerSupervisor);
    expect(tools.map((tool) => tool.name)).toEqual(["list", "read", "write", "exec"]);
    for (const tool of tools) {
      expect(tool.approval).toBe("never");
      expect(tool.exposure).toBe("default");
      expect(tool.inputSchema.type).toBe("object");
    }

    const files = [
      ...walk("components"),
      ...walk("app").filter((file) => !file.includes(`${sep}api${sep}`)),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("DAYTONA_API_KEY");
      expect(source, file).not.toContain("child_process");
    }
    const server = walk("src/sandbox").concat(walk("app/api/computer"));
    for (const file of server) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("child_process");
      expect(source, file).not.toMatch(/\breadFileSync\b/);
      expect(source, file).not.toMatch(/\bexec(File)?Sync\b/);
      expect(source, file).not.toMatch(/\bspawn(Sync)?\b/);
    }
  });

  class GateRuntime implements SandboxRuntime {
    readonly kind = "mock" as const;
    execCalls = 0;
    execSignal: AbortSignal | undefined;
    #prepareNotify = () => {};
    #execNotify = () => {};
    #releasePrepare = () => {};

    nextPrepare(): Promise<void> {
      return new Promise((resolve) => {
        this.#prepareNotify = resolve;
      });
    }

    nextExec(): Promise<void> {
      return new Promise((resolve) => {
        this.#execNotify = resolve;
      });
    }

    finishPrepare(): void {
      this.#releasePrepare();
    }

    list(): Promise<{ ok: true; entries: [] }> {
      return Promise.resolve({ ok: true, entries: [] });
    }

    read(): Promise<{ ok: false; error: string }> {
      return Promise.resolve({ ok: false, error: "missing" });
    }

    write(): Promise<{ ok: true }> {
      return Promise.resolve({ ok: true });
    }

    prepare(_agentId: string, signal?: AbortSignal): Promise<void> {
      this.#prepareNotify();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#releasePrepare = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }

    exec(
      _agentId: string,
      _command: string,
      _timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<ExecOutcome> {
      this.execCalls += 1;
      this.execSignal = signal;
      this.#execNotify();
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  class HangingRuntime implements SandboxRuntime {
    readonly kind = "mock" as const;

    list(): Promise<{ ok: true; entries: [] }> {
      return Promise.resolve({ ok: true, entries: [] });
    }

    read(): Promise<{ ok: false; error: string }> {
      return Promise.resolve({ ok: false, error: "No such file" });
    }

    write(): Promise<{ ok: true }> {
      return Promise.resolve({ ok: true });
    }

    prepare(): Promise<void> {
      return Promise.resolve();
    }

    exec(): Promise<ExecOutcome> {
      return new Promise(() => {});
    }
  }

  class CappedRuntime implements SandboxRuntime {
    readonly kind = "daytona" as const;
    reads = 0;

    constructor(
      private readonly count: number,
      private readonly size: number,
    ) {}

    list(): Promise<{ ok: true; entries: SandboxEntry[] }> {
      const entries: SandboxEntry[] = Array.from({ length: this.count }, (_, index) => ({
        name: `file-${index}.txt`,
        kind: "file",
        size: this.size,
        modifiedAt: "2026-10-26T00:00:00.000Z",
      }));
      return Promise.resolve({ ok: true, entries });
    }

    read(): Promise<{ ok: true; content: string }> {
      this.reads += 1;
      return Promise.resolve({ ok: true, content: "x" });
    }

    write(): Promise<{ ok: true }> {
      return Promise.resolve({ ok: true });
    }

    prepare(): Promise<void> {
      return Promise.resolve();
    }

    exec(): Promise<ExecOutcome> {
      return Promise.resolve({ stdout: "hi\n", stderr: "", exitCode: 0, timedOut: false });
    }
  }

  class AbortAfterExecRuntime implements SandboxRuntime {
    readonly kind = "daytona" as const;
    reads = 0;

    constructor(private readonly controller: AbortController) {}

    list(): Promise<{ ok: true; entries: SandboxEntry[] }> {
      return Promise.resolve({ ok: true, entries: [{ name: "a.txt", kind: "file" }] });
    }

    read(
      _agentId: string,
      _path: string,
      signal?: AbortSignal,
    ): Promise<{ ok: true; content: string }> {
      this.reads += 1;
      if (this.reads > 1 && signal) {
        this.controller.abort();
        return Promise.reject(
          Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        );
      }
      return Promise.resolve({ ok: true, content: "same" });
    }

    write(): Promise<{ ok: true }> {
      return Promise.resolve({ ok: true });
    }

    prepare(): Promise<void> {
      return Promise.resolve();
    }

    exec(): Promise<ExecOutcome> {
      return Promise.resolve({ stdout: "hi\n", stderr: "", exitCode: 0, timedOut: false });
    }
  }

  class FakeFleet implements RemoteSandboxFleet {
    readonly creates: Array<{ id: string; agentId: string; envVars?: unknown }> = [];
    readonly execs: Array<{ command: string; cwd: string; timeoutSec: number }> = [];
    readonly starts: string[] = [];
    readonly reconnects: string[] = [];
    readonly reads: string[] = [];
    bootMs = 0;
    failNextStart = false;
    readonly #sandboxes = new Map<string, Map<string, string>>();
    readonly #running = new Set<string>();

    stop(id: string): void {
      this.#running.delete(id);
    }

    async create(agentId: string): Promise<RemoteSandbox> {
      if (this.bootMs > 0) await new Promise((resolve) => setTimeout(resolve, this.bootMs));
      const id = `sbx-${this.creates.length + 1}`;
      this.creates.push({ id, agentId });
      this.#sandboxes.set(id, new Map());
      this.#running.add(id);
      return this.#handle(id);
    }

    async reconnect(sandboxId: string): Promise<RemoteSandbox | null> {
      this.reconnects.push(sandboxId);
      if (!this.#sandboxes.has(sandboxId)) return null;
      if (!this.#running.has(sandboxId)) {
        this.starts.push(sandboxId);
        this.#running.add(sandboxId);
      }
      return this.#handle(sandboxId);
    }

    #handle(id: string): RemoteSandbox {
      const files = this.#sandboxes.get(id);
      if (!files) throw new Error("missing sandbox");
      const execs = this.execs;
      const reads = this.reads;
      return {
        id,
        ensureRunning: async () => {
          if (this.#running.has(id)) return;
          if (this.failNextStart) {
            this.failNextStart = false;
            throw new Error("Sandbox failed to start");
          }
          this.starts.push(id);
          this.#running.add(id);
        },
        async list(dir: string) {
          const prefix = dir.endsWith("/") || dir === "" ? dir : `${dir}/`;
          const names = new Map<string, "file" | "dir">();
          for (const path of files.keys()) {
            if (prefix && !path.startsWith(prefix)) continue;
            const rest = prefix ? path.slice(prefix.length) : path;
            if (!rest) continue;
            const slash = rest.indexOf("/");
            const name = slash === -1 ? rest : rest.slice(0, slash);
            if (!name) continue;
            const kind = slash === -1 ? "file" : "dir";
            if (names.get(name) !== "dir") names.set(name, kind);
          }
          return {
            ok: true as const,
            entries: [...names].map(([name, kind]) => ({ name, kind })),
          };
        },
        async read(path: string) {
          reads.push(path);
          const content = files.get(path);
          if (content === undefined) return { ok: false as const, error: `No such file: ${path}` };
          return { ok: true as const, content };
        },
        async write(path: string, content: string) {
          files.set(path, content);
        },
        exec: async (command: string, cwd: string, timeoutSec: number) => {
          if (!this.#running.has(id)) throw new Error("Sandbox is stopped");
          execs.push({ command, cwd, timeoutSec });
          if (command === "revise") {
            files.set(`${cwd}/note.txt`, "new");
            files.set(`${cwd}/created.txt`, "fresh");
            return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false };
          }
          if (command.startsWith("echo ")) {
            return { stdout: `${command.slice(5)}\n`, stderr: "", exitCode: 0, timedOut: false };
          }
          const match = command.match(/^cat\s+(\S+)$/);
          if (!match) return { stdout: "", stderr: "unsupported", exitCode: 1, timedOut: false };
          const content = files.get(`${cwd}/${match[1]}`);
          if (content === undefined) {
            return { stdout: "", stderr: "missing", exitCode: 1, timedOut: false };
          }
          return { stdout: content, stderr: "", exitCode: 0, timedOut: false };
        },
      };
    }
  }

  function walk(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const info = statSync(path);
      if (info.isDirectory()) found.push(...walk(path));
      else if (/\.(tsx?|css)$/.test(entry)) found.push(path);
    }
    return found;
  }

  async function toolNames(
    provider: SandboxTurnProvider,
    messages: Array<{ role: "system" | "user"; content: string }>,
  ): Promise<string[]> {
    const names: string[] = [];
    for await (const event of provider.stream(messages)) {
      if (event.type === "tool_call" && event.name) names.push(event.name);
    }
    return names;
  }

  async function POST_CHAT(request: Request): Promise<Response> {
    const { POST: chat } = await import("../app/api/chat/route");
    return chat(request);
  }
});
